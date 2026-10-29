// Real-time Chrome runner (virtual time cannot reliably exercise getUserMedia).
// node tests/browser-check.cjs [URL] [--camera] [--screenshot|--interaction]
const fs=require('fs'),os=require('os'),path=require('path'),http=require('http');
const net=require('net'),crypto=require('crypto'),{spawn}=require('child_process');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const get=url=>new Promise((resolve,reject)=>http.get(url,res=> {
  let data=''; res.on('data',chunk=>data+=chunk); res.on('end',()=>resolve(JSON.parse(data)));
}).on('error',reject));
async function connect(url) {
  const target=new URL(url),socket=net.connect(Number(target.port),target.hostname);
  let buffer=Buffer.alloc(0),upgraded=false,id=0;
  const pending=new Map();
  let readyResolve,readyReject;
  const ready=new Promise((resolve,reject)=> { readyResolve=resolve;readyReject=reject; });
  socket.on('error',readyReject);
  socket.on('connect',()=>socket.write(`GET ${target.pathname} HTTP/1.1\r\nHost: ${target.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\n\r\n`));
  function send(payload,opcode=1) {
    const body=Buffer.from(payload),mask=crypto.randomBytes(4);
    const header=Buffer.alloc(body.length<126 ? 2 : body.length<65536 ? 4 : 10);
    header[0]=0x80|opcode;
    if(body.length<126) header[1]=0x80|body.length;
    else if(body.length<65536) { header[1]=0x80|126;header.writeUInt16BE(body.length,2); }
    else { header[1]=0x80|127;header.writeBigUInt64BE(BigInt(body.length),2); }
    for(let i=0;i<body.length;i++) body[i]^=mask[i%4];
    socket.write(Buffer.concat([header,mask,body]));
  }
  socket.on('data',chunk=> {
    buffer=Buffer.concat([buffer,chunk]);
    if(!upgraded) {
      const end=buffer.indexOf('\r\n\r\n'); if(end<0) return;
      if(!buffer.subarray(0,end).toString().startsWith('HTTP/1.1 101')) return readyReject(new Error('WebSocket upgrade failed'));
      buffer=buffer.subarray(end+4); upgraded=true; readyResolve();
    }
    while(buffer.length>=2) {
      const opcode=buffer[0]&15; let length=buffer[1]&127,offset=2;
      if(length===126) { if(buffer.length<4) return;length=buffer.readUInt16BE(2);offset=4; }
      else if(length===127) { if(buffer.length<10) return;length=Number(buffer.readBigUInt64BE(2));offset=10; }
      if(buffer.length<offset+length) return;
      const body=buffer.subarray(offset,offset+length);buffer=buffer.subarray(offset+length);
      if(opcode===9) { send(body,10);continue; }
      if(opcode!==1) continue;
      const message=JSON.parse(body.toString());
      if(message.method==='Runtime.consoleAPICalled' && message.params.type==='error') {
        console.error('Browser:',message.params.args.map(arg=>arg.value||arg.description||'').join(' '));
      }
      if(message.id && pending.has(message.id)) {
        const task=pending.get(message.id);pending.delete(message.id);
        message.error ? task.reject(new Error(JSON.stringify(message.error))) : task.resolve(message.result);
      }
    }
  });
  await ready;
  return {
    call:(method,params={})=>new Promise((resolve,reject)=> { const callId=++id;pending.set(callId,{resolve,reject});send(JSON.stringify({id:callId,method,params})); }),
    close:()=>socket.destroy(),
  };
}
(async()=> {
  const target=process.argv.find(arg=>arg.startsWith('http'))||'http://127.0.0.1:5501/tests/gestures.html';
  const camera=process.argv.includes('--camera');
  const profile=fs.mkdtempSync(path.join(os.tmpdir(),'misty-browser-'));
  const browser=spawn('C:/Program Files/Google/Chrome/Application/chrome.exe',[
    '--headless','--no-sandbox','--enable-unsafe-swiftshader','--no-first-run','--no-default-browser-check',
    '--remote-debugging-port=0','--window-size=1280,900',`--user-data-dir=${profile}`,
    ...(camera ? ['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream'] : []),'about:blank',
  ],{windowsHide:true,stdio:'ignore'});
  let client;
  const timeout=setTimeout(()=> { browser.kill();process.exitCode=1;console.error('Browser check timeout');process.exit(1); },90000);
  try {
    const portFile=path.join(profile,'DevToolsActivePort');
    for(let i=0;!fs.existsSync(portFile)&&i<100;i++) await delay(100);
    const port=fs.readFileSync(portFile,'utf8').split('\n')[0];
    const tabs=await get(`http://127.0.0.1:${port}/json/list`);
    client=await connect(tabs.find(tab=>tab.type==='page').webSocketDebuggerUrl);
    await client.call('Page.enable');
    await client.call('Runtime.enable');
    await client.call('Page.navigate',{url:target});
    await delay(700);
    if(process.argv.includes('--interaction')) {
      await delay(1500);
      const view=await client.call('Runtime.evaluate',{expression:`({width:innerWidth,height:innerHeight})`,returnByValue:true});
      const {width,height}=view.result.value;
      const x=width*.44,y=height*.5,r=height*.12;
      await client.call('Input.dispatchMouseEvent',{type:'mousePressed',x:x+r,y,button:'left',buttons:1,clickCount:1});
      for(let i=1;i<=48;i++) {
        const phase=i/48*Math.PI*2;
        await client.call('Input.dispatchMouseEvent',{type:'mouseMoved',x:x+Math.cos(phase)*r,y:y+Math.sin(phase)*r,button:'left',buttons:1});
        await delay(8);
      }
      await client.call('Input.dispatchMouseEvent',{type:'mouseReleased',x:x+r,y,button:'left',buttons:0,clickCount:1});
      await delay(150);
      const readMask=`(()=> {
        const gl=document.querySelector('#experiment canvas').getContext('webgl2');
        const program=gl.getParameter(gl.CURRENT_PROGRAM),unit=gl.getUniform(program,gl.getUniformLocation(program,'uWipe'));
        const active=gl.getParameter(gl.ACTIVE_TEXTURE),previous=gl.getParameter(gl.FRAMEBUFFER_BINDING);
        gl.activeTexture(gl.TEXTURE0+unit);const texture=gl.getParameter(gl.TEXTURE_BINDING_2D);
        const fb=gl.createFramebuffer();gl.bindFramebuffer(gl.FRAMEBUFFER,fb);gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,texture,0);
        const h=Math.round(Math.min(384,512/Math.max(1,innerWidth/innerHeight))),w=Math.round(h*innerWidth/innerHeight);
        const pixels=new Uint8Array(w*h*4);gl.readPixels(0,0,w,h,gl.RGBA,gl.UNSIGNED_BYTE,pixels);
        gl.bindFramebuffer(gl.FRAMEBUFFER,previous);gl.deleteFramebuffer(fb);gl.activeTexture(active);
        let sum=0;for(let i=3;i<pixels.length;i+=4) sum+=pixels[i];return sum;
      })()`;
      const mask=await client.call('Runtime.evaluate',{expression:readMask,returnByValue:true});
      if(!(mask.result.value>0)) throw new Error('Pointer stroke failed to update GPU wiping texture: '+JSON.stringify(mask));
      console.log('PASS real mouse drag updates GPU wiping texture');
      const image=await client.call('Page.captureScreenshot',{format:'png'});
      const filename=path.join(os.tmpdir(),'misty-gesture-drawing.png');
      fs.writeFileSync(filename,Buffer.from(image.data,'base64'));console.log(filename);
      await client.call('Runtime.evaluate',{expression:`document.getElementById('clear-strokes').click()`});
      await delay(150);
      const cleared=await client.call('Runtime.evaluate',{expression:readMask,returnByValue:true});
      if(cleared.result.value!==0) throw new Error('Clear did not reset GPU texture');
      console.log('PASS clear button resets GPU wiping texture\nALL CHECKS PASSED');
    } else if(process.argv.includes('--screenshot')) {
      await delay(1800);
      const image=await client.call('Page.captureScreenshot',{format:'png'});
      const filename=path.join(os.tmpdir(),'misty-gesture-preview.png');
      fs.writeFileSync(filename,Buffer.from(image.data,'base64'));console.log(filename);
    } else {
      const result=await client.call('Runtime.evaluate',{
        expression:`new Promise(resolve=> { const start=performance.now();const timer=setInterval(()=> { const text=document.getElementById('result')?.textContent||'';if(text.includes('ALL CHECKS PASSED')||text.includes('FAIL')||performance.now()-start>75000) { clearInterval(timer);resolve(text); } },100); })`,
        awaitPromise:true,returnByValue:true,
      });
      const output=result.result?.value||JSON.stringify(result);
      console.log(output);if(!output.includes('ALL CHECKS PASSED')) process.exitCode=1;
    }
  } finally { clearTimeout(timeout);client?.close();browser.kill(); }
})().catch(error=> { console.error(error);process.exitCode=1; });
