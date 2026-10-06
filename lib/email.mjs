import nodemailer from 'nodemailer';
import {securityError} from './security.mjs';

export function normalizeEmail(value){
  const email=typeof value==='string'?value.trim().toLowerCase():'';
  const [local='',domain='',...extra]=email.split('@');
  if(email.length>254||local.length<1||local.length>64||extra.length||local.startsWith('.')||local.endsWith('.')||local.includes('..')||! /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local)||! /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain))throw securityError('INVALID_EMAIL','请输入有效的邮箱地址。',400);
  return email;
}

export function maskedEmail(email){if(!email)return null;const [local,domain]=email.split('@');return local.slice(0,Math.min(2,local.length))+'***@'+domain;}

export function createMailer({env=process.env,production=false}={}){
  const configured=!!(env.SMTP_HOST&&env.SMTP_USER&&env.SMTP_PASS&&env.MAIL_FROM);
  if(!configured)return {enabled:false,sendBinding:()=>Promise.reject(unavailable()),sendReset:()=>Promise.reject(unavailable()),sendChanged:()=>Promise.reject(unavailable()),close(){}};
  const secure=env.SMTP_SECURE===undefined||env.SMTP_SECURE==='true',port=Number(env.SMTP_PORT||465);
  if(!Number.isInteger(port)||port<1||port>65535||!['true','false',undefined].includes(env.SMTP_SECURE))throw new Error('Invalid SMTP configuration');
  const from=normalizeEmail(env.MAIL_FROM),local=!production&&['127.0.0.1','localhost','::1'].includes(env.SMTP_HOST);
  const transport=nodemailer.createTransport({host:env.SMTP_HOST,port,secure,requireTLS:!secure&&!local,ignoreTLS:local&&!secure,auth:{user:env.SMTP_USER,pass:env.SMTP_PASS},connectionTimeout:10000,greetingTimeout:10000,socketTimeout:15000,logger:false,debug:false,disableFileAccess:true,disableUrlAccess:true});
  let active=0;const pending=[];
  function send(to,subject,text){
    return new Promise((resolve,reject)=>{
      if(active>=2&&pending.length>=4)return reject(securityError('MAIL_BUSY','邮件发送繁忙，请稍后再试。',503));
      const run=()=>{active++;transport.sendMail({from:{name:'海克斯麻将',address:from},to:normalizeEmail(to),subject,text}).then(result=>{if(!result.accepted?.length)throw unavailable();resolve();}).catch(()=>reject(unavailable())).finally(()=>{active--;pending.shift()?.();});};
      if(active<2)run();else pending.push(run);
    });
  }
  return {enabled:true,
    sendBinding:(email,code)=>send(email,'海克斯麻将 · 邮箱验证码',`你的邮箱绑定验证码是：${code}\n\n验证码 10 分钟内有效，只能用于当前账号绑定此邮箱。请勿向他人提供验证码。\n如果不是你本人操作，请忽略此邮件。`),
    sendReset:(email,url)=>send(email,'海克斯麻将 · 重置密码',`我们收到了此邮箱对应账号的密码重置申请。\n\n请打开下面的链接设置新密码：\n${url}\n\n链接 15 分钟内有效，仅可使用一次。重置后所有设备需重新登录，你的私人海克斯和卡池会保留。\n如果不是你本人操作，请忽略此邮件，当前密码不会改变。`),
    sendChanged:email=>send(email,'海克斯麻将 · 邮箱变更通知','你的海克斯麻将账号已验证并绑定新的邮箱，此邮箱不再用于该账号的密码找回。\n如果不是你本人操作，请及时检查账号安全。'),
    close:()=>transport.close()
  };
}
function unavailable(){return securityError('MAIL_UNAVAILABLE','邮件暂时无法发送，请稍后再试。',503);}
