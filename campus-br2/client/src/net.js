export class Net {
  constructor(handlers) { this.h = handlers; this.ws = null; }
  connect(name, squad) {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    this.ws = new WebSocket(`${proto}://${location.host}`);
    this.ws.onopen = () => this.send({ t: 'join', name, squad });
    this.ws.onmessage = e => { const m = JSON.parse(e.data); if (this.h[m.t]) this.h[m.t](m); };
    this.ws.onclose = () => this.h.close && this.h.close();
  }
  send(o) { if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(o)); }
}
