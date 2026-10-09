from pathlib import Path
import sqlite3
import hashlib
import hmac
import re
import secrets
import os

from fastapi import FastAPI, Request, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from starlette.middleware.sessions import SessionMiddleware

app = FastAPI()

# Signed login sessions
app.add_middleware(
    SessionMiddleware,
    secret_key=os.getenv(
        "CHAT_SESSION_SECRET",
        "local-demo-change-this-secret-before-deployment"
    ),
    max_age=43200,
    same_site="lax",
    https_only=False
)

# A separate database for authenticated users and their messages
BASE_DIR = Path(__file__).resolve().parents[2]
db = sqlite3.connect(BASE_DIR / "auth_chat.db", check_same_thread=False)
db.row_factory = sqlite3.Row

db.execute("""
CREATE TABLE IF NOT EXISTS users (
    username TEXT PRIMARY KEY COLLATE NOCASE,
    salt TEXT NOT NULL,
    password_hash TEXT NOT NULL
)
""")

db.execute("""
CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sender TEXT NOT NULL,
    recipient TEXT NOT NULL,
    message TEXT NOT NULL,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
)
""")
db.execute("""
CREATE TABLE IF NOT EXISTS hidden_messages (
    username TEXT NOT NULL,
    message_id INTEGER NOT NULL,
    PRIMARY KEY (username, message_id)
)
""")
db.execute("""
CREATE TABLE IF NOT EXISTS chat_groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    created_by TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)
""")

db.execute("""
CREATE TABLE IF NOT EXISTS group_members (
    group_id INTEGER NOT NULL,
    username TEXT NOT NULL,
    joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (group_id, username)
)
""")

db.execute("""
CREATE TABLE IF NOT EXISTS group_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id INTEGER NOT NULL,
    sender TEXT NOT NULL,
    message TEXT NOT NULL,
    message_type TEXT NOT NULL DEFAULT 'text',
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
)
""")
db.execute("""
CREATE TABLE IF NOT EXISTS hidden_group_messages (
    username TEXT NOT NULL,
    message_id INTEGER NOT NULL,
    PRIMARY KEY (username, message_id)
)
""")
columns = {
    row["name"]
    for row in db.execute("PRAGMA table_info(messages)").fetchall()
}

if "message_type" not in columns:
    db.execute("""
        ALTER TABLE messages
        ADD COLUMN message_type TEXT NOT NULL DEFAULT 'text'
    """)

db.commit()

connections = {}


# ---------- HELPERS ----------

class AuthData(BaseModel):
    username: str
    password: str


def clean_username(value):
    username = value.strip().lower()

    if not re.fullmatch(r"[a-z0-9_.-]{3,24}", username):
        raise HTTPException(
            status_code=400,
            detail="Username must be 3–24 characters: letters, numbers, _, . or -."
        )

    return username


def hash_password(password, salt):
    return hashlib.scrypt(
        password.encode(),
        salt=salt,
        n=2**14,
        r=8,
        p=1,
        dklen=32
    ).hex()


def current_user(request):
    username = request.session.get("username")

    if not username:
        raise HTTPException(status_code=401, detail="Please log in.")

    return username


# ---------- REGISTER / LOGIN / LOGOUT ----------

@app.post("/api/register")
def register(data: AuthData, request: Request):
    username = clean_username(data.username)

    if len(data.password) < 8:
        raise HTTPException(
            status_code=400,
            detail="Password must contain at least 8 characters."
        )

    salt = secrets.token_bytes(16)
    password_hash = hash_password(data.password, salt)

    try:
        db.execute(
            "INSERT INTO users (username, salt, password_hash) VALUES (?, ?, ?)",
            (username, salt.hex(), password_hash)
        )
        db.commit()
    except sqlite3.IntegrityError:
        raise HTTPException(
            status_code=409,
            detail="Username already exists. Please log in."
        )

    request.session.clear()
    request.session["username"] = username

    return {"username": username}


@app.post("/api/login")
def login(data: AuthData, request: Request):
    username = clean_username(data.username)

    user = db.execute(
        "SELECT * FROM users WHERE username = ?",
        (username,)
    ).fetchone()

    if not user:
        raise HTTPException(
            status_code=401,
            detail="Invalid username or password."
        )

    expected = hash_password(
        data.password,
        bytes.fromhex(user["salt"])
    )

    if not hmac.compare_digest(expected, user["password_hash"]):
        raise HTTPException(
            status_code=401,
            detail="Invalid username or password."
        )

    request.session.clear()
    request.session["username"] = user["username"]

    return {"username": user["username"]}


@app.get("/api/me")
def me(request: Request):
    return {"username": current_user(request)}


@app.post("/api/logout")
def logout(request: Request):
    request.session.clear()
    return {"ok": True}

# ---------- GROUP CHAT API ----------

class CreateGroupData(BaseModel):
    name: str
    members: list[str] = []


class AddMemberData(BaseModel):
    username: str


@app.post("/api/groups")
def create_group(data: CreateGroupData, request: Request):
    creator = current_user(request)
    name = data.name.strip()

    if not name or len(name) > 50:
        raise HTTPException(400, "Group name must be 1–50 characters.")

    members = {creator}

    for member in data.members:
        members.add(clean_username(member))

    for member in members:
        exists = db.execute(
            "SELECT 1 FROM users WHERE username = ?",
            (member,)
        ).fetchone()

        if not exists:
            raise HTTPException(404, f"User '{member}' is not registered.")

    cursor = db.execute(
        "INSERT INTO chat_groups (name, created_by) VALUES (?, ?)",
        (name, creator)
    )

    group_id = cursor.lastrowid

    for member in members:
        db.execute(
            "INSERT INTO group_members (group_id, username) VALUES (?, ?)",
            (group_id, member)
        )

    db.commit()

    return {"id": group_id, "name": name, "members": list(members)}


@app.get("/api/groups")
def list_groups(request: Request):
    username = current_user(request)

    rows = db.execute("""
        SELECT g.id, g.name, g.created_by
        FROM chat_groups g
        JOIN group_members m ON m.group_id = g.id
        WHERE m.username = ?
        ORDER BY g.id DESC
    """, (username,)).fetchall()

    return [dict(row) for row in rows]


@app.post("/api/groups/{group_id}/members")
def add_group_member(
    group_id: int,
    data: AddMemberData,
    request: Request
):
    username = current_user(request)
    new_member = clean_username(data.username)

    membership = db.execute(
        "SELECT 1 FROM group_members WHERE group_id = ? AND username = ?",
        (group_id, username)
    ).fetchone()

    if not membership:
        raise HTTPException(403, "You are not a member of this group.")

    exists = db.execute(
        "SELECT 1 FROM users WHERE username = ?",
        (new_member,)
    ).fetchone()

    if not exists:
        raise HTTPException(404, "That user is not registered.")

    db.execute(
        "INSERT OR IGNORE INTO group_members (group_id, username) VALUES (?, ?)",
        (group_id, new_member)
    )
    db.commit()

    return {"ok": True, "username": new_member}


@app.get("/api/groups/{group_id}/messages")
def get_group_messages(group_id: int, request: Request):
    username = current_user(request)

    membership = db.execute(
        "SELECT 1 FROM group_members WHERE group_id = ? AND username = ?",
        (group_id, username)
    ).fetchone()

    if not membership:
        raise HTTPException(403, "You are not a member of this group.")

    rows = db.execute("""
    SELECT id, sender, message, message_type, timestamp
    FROM group_messages
    WHERE group_id = ?
    AND id NOT IN (
        SELECT message_id
        FROM hidden_group_messages
        WHERE username = ?
    )
    ORDER BY id
""", (group_id, username)).fetchall()

    return [dict(row) for row in rows]

# ---------- AUTHENTICATED CHAT ----------

@app.websocket("/ws")
async def chat(websocket: WebSocket):
    username = websocket.session.get("username")

    # Reject users without a valid login session
    if not username:
        await websocket.close(code=1008)
        return

    await websocket.accept()
    connections[username] = websocket

    try:
        rows = db.execute("""
            SELECT id, sender, recipient, message, message_type, timestamp
            FROM messages
            WHERE (sender = ? OR recipient = ?)
            AND id NOT IN (
                SELECT message_id FROM hidden_messages
                WHERE username = ?
            )
            ORDER BY id
        """, (username,username,username)).fetchall()

        await websocket.send_json({
            "type": "history",
            "messages": [dict(row) for row in rows]
        })

        while True:
            data = await websocket.receive_json()
            if data.get("action") == "delete":
                try:
                    message_id = int(data.get("id"))
                except (TypeError, ValueError):
                    continue

                scope = data.get("scope", "me")

                row = db.execute(
                    "SELECT id, sender, recipient FROM messages WHERE id = ?",
                    (message_id,)
                ).fetchone()

                if not row or username not in (row["sender"], row["recipient"]):
                    await websocket.send_json({
                        "type": "error",
                        "message": "Message not found."
                    })
                    continue

                if scope == "everyone":
                    if row["sender"] != username:
                        await websocket.send_json({
                            "type": "error",
                            "message": "You can only delete your own messages for everyone."
                        })
                        continue

                    db.execute("DELETE FROM messages WHERE id = ?", (message_id,))
                    db.commit()

                    event = {"type": "deleted", "id": message_id, "scope": "everyone"}

                    await websocket.send_json(event)

                    recipient = row["recipient"]
                    if recipient in connections:
                        await connections[recipient].send_json(event)

                elif scope == "me":
                    db.execute(
                        """INSERT OR IGNORE INTO hidden_messages
                        (username, message_id) VALUES (?, ?)""",
                        (username, message_id)
                    )
                    db.commit()

                    await websocket.send_json({
                        "type": "deleted",
                        "id": message_id,
                        "scope": "me"
                    })

                continue
            if data.get("action") == "delete_group_message":
                try:
                    group_id = int(data.get("group_id"))
                    message_id = int(data.get("id"))
                except (TypeError, ValueError):
                    continue

                scope = data.get("scope", "me")

                membership = db.execute(
                    """SELECT 1 FROM group_members
                    WHERE group_id = ? AND username = ?""",
                    (group_id, username)
                ).fetchone()

                if not membership:
                    await websocket.send_json({
                        "type": "error",
                        "message": "You are not a member of this group."
                    })
                    continue

                row = db.execute(
                    """SELECT id, sender FROM group_messages
                    WHERE id = ? AND group_id = ?""",
                    (message_id, group_id)
                ).fetchone()

                if not row:
                    continue

                if scope == "everyone":
                    if row["sender"] != username:
                        await websocket.send_json({
                            "type": "error",
                            "message": "You can only delete your own messages for everyone."
                        })
                        continue

                    db.execute(
                        "DELETE FROM group_messages WHERE id = ? AND group_id = ?",
                        (message_id, group_id)
                    )
                    db.commit()

                    event = {
                        "type": "deleted",
                        "id": message_id,
                        "group_id": group_id,
                        "scope": "everyone"
                    }

                    members = db.execute(
                        "SELECT username FROM group_members WHERE group_id = ?",
                        (group_id,)
                    ).fetchall()

                    for member in members:
                        member_name = member["username"]
                        if member_name in connections:
                            await connections[member_name].send_json(event)

                elif scope == "me":
                    db.execute(
                        """INSERT OR IGNORE INTO hidden_group_messages
                        (username, message_id) VALUES (?, ?)""",
                        (username, message_id)
                    )
                    db.commit()

                    await websocket.send_json({
                        "type": "deleted",
                        "id": message_id,
                        "group_id": group_id,
                        "scope": "me"
                    })

                continue

            if data.get("action") == "group_message":
                try:
                    group_id = int(data.get("group_id"))
                except (TypeError, ValueError):
                    continue

                membership = db.execute(
                    """SELECT 1 FROM group_members
                    WHERE group_id = ? AND username = ?""",
                    (group_id, username)
                ).fetchone()

                if not membership:
                    await websocket.send_json({
                        "type": "error",
                        "message": "You are not a member of this group."
                    })
                    continue

                message = str(data.get("message", "")).strip()
                message_type = data.get("message_type", "text")

                if message_type == "image":
                    allowed = (
                        "data:image/jpeg;base64,",
                        "data:image/png;base64,",
                        "data:image/webp;base64,",
                        "data:image/gif;base64,",
                    )

                    if not message.startswith(allowed) or len(message) > 1_500_000:
                        await websocket.send_json({
                            "type": "error",
                            "message": "Invalid image or image too large (maximum 1 MB)."
                        })
                        continue

                elif message_type == "text":
                    if not message or len(message) > 4000:
                        await websocket.send_json({
                            "type": "error",
                            "message": "Message must contain 1–4000 characters."
                        })
                        continue

                else:
                    await websocket.send_json({
                        "type": "error",
                        "message": "Unsupported message type."
                    })
                    continue
                cursor = db.execute(
                    """INSERT INTO group_messages
                    (group_id, sender, message, message_type)
                    VALUES (?, ?, ?, ?)""",
                    (group_id, username, message, message_type)
                )
                db.commit()

                saved = db.execute(
                    "SELECT timestamp FROM group_messages WHERE id = ?",
                    (cursor.lastrowid,)
                ).fetchone()

                packet = {
                    "type": "group_message",
                    "id": cursor.lastrowid,
                    "group_id": group_id,
                    "sender": username,
                    "message": message,
                    "message_type": message_type,
                    "timestamp": saved["timestamp"]
                }

                await websocket.send_json(packet)

                members = db.execute(
                    "SELECT username FROM group_members WHERE group_id = ?",
                    (group_id,)
                ).fetchall()

                for member in members:
                    member_name = member["username"]

                    if member_name != username and member_name in connections:
                        await connections[member_name].send_json(packet)

                continue

            recipient = str(data.get("recipient", "")).strip().lower()
            message = str(data.get("message", "")).strip()

            if not re.fullmatch(r"[a-z0-9_.-]{3,24}", recipient):
                await websocket.send_json({
                    "type": "error",
                    "message": "Invalid recipient username."
                })
                continue

            if recipient == username:
                await websocket.send_json({
                    "type": "error",
                    "message": "You cannot message yourself."
                })
                continue

            message_type = data.get("message_type", "text")

            if message_type == "image":
                allowed = (
                    "data:image/jpeg;base64,",
                    "data:image/png;base64,",
                    "data:image/webp;base64,",
                    "data:image/gif;base64,",
                )

                if not message.startswith(allowed) or len(message) > 1_500_000:
                    await websocket.send_json({
                        "type": "error",
                        "message": "Invalid image or image too large (maximum 1 MB)."
                    })
                    continue

            elif message_type == "text":
                if not message or len(message) > 4000:
                    await websocket.send_json({
                        "type": "error",
                        "message": "Message must contain 1–4000 characters."
                    })
                    continue

            else:
                await websocket.send_json({
                    "type": "error",
                    "message": "Unsupported message type."
                })
                continue

            exists = db.execute(
                "SELECT 1 FROM users WHERE username = ?",
                (recipient,)
            ).fetchone()

            if not exists:
                await websocket.send_json({
                    "type": "error",
                    "message": "That user has not registered."
                })
                continue

            db.execute(
                """INSERT INTO messages
                (sender, recipient, message, message_type)
                VALUES (?, ?, ?, ?)""",
                (username, recipient, message, message_type)
            )
            db.commit()

            saved = db.execute(
                "SELECT id, timestamp FROM messages WHERE id = last_insert_rowid()"
            ).fetchone()

            packet = {
                "id": saved["id"],
                "type": "message",
                "sender": username,
                "recipient": recipient,
                "message": message,
                "message_type": message_type,
                "timestamp": saved["timestamp"]
            }

            await websocket.send_json(packet)

            if recipient in connections:
                await connections[recipient].send_json(packet)

    except WebSocketDisconnect:
        pass
    finally:
        if connections.get(username) is websocket:
            connections.pop(username, None)


# Serve the frontend last so it doesn't override API routes
client_folder = Path(__file__).resolve().parent.parent / "client"

app.mount(
    "/",
    StaticFiles(directory=str(client_folder), html=True),
    name="client"
)