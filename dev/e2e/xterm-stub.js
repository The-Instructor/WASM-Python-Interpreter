window.Terminal = class {
  constructor(){ this.buf=''; this.handlers=[]; }
  loadAddon(){}
  open(el){ this.el=el; el.innerHTML='<pre id="xterm-out" style="color:#ddd;margin:0;white-space:pre-wrap"></pre>'; }
  write(s){ this.buf+=s; const p=this.el&&this.el.querySelector('pre'); if(p) p.textContent=this.buf.replace(/\x1b\[[0-9;]*m/g,''); }
  writeln(s){ this.write(s+'\r\n'); }
  onData(f){ this.handlers.push(f); }
  focus(){}
  _type(s){ this.handlers.forEach(h=>h(s)); }
};
window.FitAddon = { FitAddon: class { fit(){} } };
