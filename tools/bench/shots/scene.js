const stage = document.querySelector('#stage');
const kind = stage.dataset.kind;
const tiles = [];
if (kind.startsWith('dom') || kind === 'mixed') {
  const count = kind === 'dom-heavy' ? 1200 : 12;
  for (let i = 0; i < count; i++) {
    const tile = document.createElement('div');
    tile.className = 'tile'; tile.textContent = `Item ${i}`;
    tile.style.left = `${(i % 40) * 48}px`; tile.style.top = `${Math.floor(i / 40) * 35}px`;
    if (kind === 'dom-heavy') tile.style.filter = `blur(${i % 3 * 0.15}px)`;
    stage.append(tile); tiles.push(tile);
  }
}
let canvas, ctx, gl, program, timeLocation;
if (['canvas-2d', 'webgl', 'mixed'].includes(kind)) {
  canvas = document.createElement('canvas'); stage.append(canvas);
  canvas.width = 1920 * devicePixelRatio; canvas.height = 1080 * devicePixelRatio;
  if (kind === 'canvas-2d') ctx = canvas.getContext('2d', { alpha: false, colorSpace: 'srgb' });
  else {
    gl = canvas.getContext('webgl', { alpha: kind === 'mixed', premultipliedAlpha: true, antialias: true, preserveDrawingBuffer: true });
    if (!gl) throw Error('WebGL unavailable');
    const shader = (type, source) => { const s = gl.createShader(type); gl.shaderSource(s, source); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw Error(gl.getShaderInfoLog(s)); return s; };
    program = gl.createProgram();
    gl.attachShader(program, shader(gl.VERTEX_SHADER, 'attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}'));
    gl.attachShader(program, shader(gl.FRAGMENT_SHADER, `precision highp float;uniform float t;uniform vec2 size;void main(){vec2 p=gl_FragCoord.xy/size;float stripe=step(.5,fract((p.x+p.y)*12.+t));gl_FragColor=vec4(.15+.55*p.x,.2+.5*p.y,.25+.4*stripe,${kind === 'mixed' ? '.5' : '1.'});}`));
    gl.linkProgram(program); if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw Error(gl.getProgramInfoLog(program));
    gl.useProgram(program); const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER,b); gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,-1,1,-1,1,1,-1,1,1]),gl.STATIC_DRAW);
    const loc=gl.getAttribLocation(program,'p');gl.enableVertexAttribArray(loc);gl.vertexAttribPointer(loc,2,gl.FLOAT,false,0,0);
    gl.uniform2f(gl.getUniformLocation(program,'size'),canvas.width,canvas.height);timeLocation=gl.getUniformLocation(program,'t');gl.viewport(0,0,canvas.width,canvas.height);
    window.BENCH_GL = gl;
  }
}
window.SHOT = {
  duration: 2, fps: 30, ready: document.fonts.load('16px Bench'),
  render(t) {
    for (let i=0;i<tiles.length;i++) tiles[i].style.transform=`translate(${Math.sin(t*3+i)*20}px,${Math.cos(t*2+i)*10}px)`;
    if(ctx){
      // Capture can temporarily change DPR; use the fixed backing-store dimensions.
      ctx.setTransform(canvas.width/1920,0,0,canvas.height/1080,0,0);ctx.fillStyle='#18202c';ctx.fillRect(0,0,1920,1080);
      for(let i=0;i<160;i++){ctx.fillStyle=`hsl(${i*17%360} 60% 60%)`;ctx.beginPath();ctx.arc((i%20)*96+48+Math.sin(t*3+i)*20,Math.floor(i/20)*130+65,28+i%9,0,Math.PI*2);ctx.fill();}
      ctx.fillStyle='#ffffff80';ctx.fillRect(300+t*100,250,600,400);
    }
    if(gl){gl.uniform1f(timeLocation,t);gl.drawArrays(gl.TRIANGLES,0,6);gl.finish();}
  }
};
