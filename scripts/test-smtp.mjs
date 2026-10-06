// An isolated SMTP sink used only by tests; it never relays mail to the Internet.
import net from 'node:net';

export async function createTestSmtp(){
  const messages=[],sockets=new Set();let failNext=false;
  const server=net.createServer(socket=>{
    sockets.add(socket);socket.on('close',()=>sockets.delete(socket));socket.on('error',()=>{});
    socket.write('220 local.test ESMTP\r\n');let buffer='',collecting=false,lines=[],recipient='';
    socket.on('data',chunk=>{
      buffer+=String(chunk);let end;
      while((end=buffer.indexOf('\r\n'))>=0){
        const line=buffer.slice(0,end);buffer=buffer.slice(end+2);
        if(collecting){if(line!=='.'){lines.push(line.startsWith('..')?line.slice(1):line);continue;}collecting=false;
          if(failNext){failNext=false;socket.write('451 temporary test failure\r\n');}else{messages.push({recipient,raw:lines.join('\r\n')});socket.write('250 queued\r\n');}lines=[];continue;}
        if(/^EHLO|^HELO/.test(line))socket.write('250-local.test\r\n250 AUTH PLAIN\r\n');
        else if(/^AUTH/.test(line))socket.write('235 authenticated\r\n');
        else if(/^MAIL FROM/.test(line))socket.write('250 sender OK\r\n');
        else if(/^RCPT TO/.test(line)){recipient=line.match(/<([^>]+)>/)?.[1]||'';socket.write('250 recipient OK\r\n');}
        else if(line==='DATA'){collecting=true;socket.write('354 end with dot\r\n');}
        else if(line==='QUIT'){socket.end('221 goodbye\r\n');}
        else socket.write('250 OK\r\n');
      }
    });
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  return {port:server.address().port,messages,failNext(){failNext=true;},close(){for(const socket of sockets)socket.destroy();return new Promise(resolve=>server.close(resolve));}};
}

export function mailText(message){
  const raw=message.raw,split=raw.indexOf('\r\n\r\n'),headers=raw.slice(0,split),body=raw.slice(split+4);
  if(/Content-Transfer-Encoding: base64/i.test(headers))return Buffer.from(body.replace(/\s/g,''),'base64').toString('utf8');
  if(/Content-Transfer-Encoding: quoted-printable/i.test(headers)){const joined=body.replace(/=\r\n/g,'');return Buffer.from(joined.replace(/=([0-9A-F]{2})/gi,(_,hex)=>String.fromCharCode(parseInt(hex,16))),'binary').toString('utf8');}
  return body;
}
