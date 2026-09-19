export const REMOTE_PAGE = `<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>hummin · remote control</title>
<style>
:root{color-scheme:dark;font:16px/1.5 ui-monospace,monospace;background:#161918;color:#e4e8e6}
body{max-width:850px;margin:0 auto;padding:24px}header{border-bottom:1px solid #404743;padding-bottom:16px}
h1{font-size:20px;margin:0}#status{color:#9cc8b9}#error{color:#ffb8a0;min-height:1.5em}
#approval{margin-top:8px;border:1px solid #ffb8a0;padding:8px 12px}#approval[hidden]{display:none}#approval-title{overflow-wrap:anywhere}#approval-note{margin-top:4px}
article{border-bottom:1px solid #303632;padding:16px 0}h2{font-size:13px;color:#9cc8b9;margin:0 0 8px}
pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit;margin:0}textarea{box-sizing:border-box;width:100%;min-height:110px;background:#202623;color:inherit;border:1px solid #59635d;padding:12px;font:inherit}
form{position:sticky;bottom:0;background:#161918;padding:16px 0}button{font:inherit;padding:8px 16px;margin:8px 8px 0 0;border:1px solid #64746a;background:#26372f;color:inherit;cursor:pointer}button:disabled{opacity:.5}small{display:block;color:#a2ada7;margin-top:8px}
</style>
<header><h1>hummin</h1><div id="status" role="status">Connecting…</div>
<div id="approval" hidden><span id="approval-title"></span><button id="approve" type="button">Approve</button><button id="deny" type="button">Deny</button><small id="approval-note"></small></div>
</header>
<main id="messages"></main><form id="form"><label for="prompt">Message</label><textarea id="prompt" maxlength="12000" required></textarea>
<button id="send" type="submit">Send</button><button id="abort" type="button">Stop response</button>
<small>Messages sent during a response are queued. When an approval is pending it appears above; the first answer (here or in the terminal) wins.</small><div id="error" role="alert"></div></form>
<script>
const token=location.hash.slice(1);history.replaceState(null,'',location.pathname);
const status=document.getElementById('status'), messages=document.getElementById('messages'), error=document.getElementById('error');
let last='', pending=null;
async function request(path,body){const result=await fetch(path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});const data=await result.json();if(!result.ok)throw new Error(data.error||'Request failed');return data;}
async function poll(){try{const state=await request('/state');status.textContent=state.name+' · '+state.model+' · '+state.status;
const rendered=JSON.stringify(state.messages);if(rendered!==last){last=rendered;messages.replaceChildren();for(const message of state.messages){const row=document.createElement('article'),title=document.createElement('h2'),text=document.createElement('pre');title.textContent=message.role;text.textContent=message.text;row.append(title,text);messages.append(row);}}
const a=state.approval;if(a){approval.hidden=false;approval.dataset.id=a.id;approvalTitle.textContent='Approval requested: '+a.tool+' '+a.input;if(a.answerable){approvalNote.textContent='';approveBtn.disabled=false;denyBtn.disabled=false;}else{approvalNote.textContent='Approve in terminal.';approveBtn.disabled=true;denyBtn.disabled=true;}}else{approval.hidden=true;}}
catch(e){status.textContent='Disconnected · retrying';error.textContent=e.message;}setTimeout(poll,1500);}
const approval=document.getElementById('approval'),approvalTitle=document.getElementById('approval-title'),approvalNote=document.getElementById('approval-note'),approveBtn=document.getElementById('approve'),denyBtn=document.getElementById('deny');
async function answer(allow){const title=approvalTitle.textContent||'';approveBtn.disabled=denyBtn.disabled=true;try{await request('/approve',{id:approval.dataset.id,allow});error.textContent='';approval.hidden=true;}catch(e){error.textContent=e.message;}finally{approveBtn.disabled=false;denyBtn.disabled=false;approvalTitle.textContent=title;}}
approveBtn.addEventListener('click',()=>answer(true));denyBtn.addEventListener('click',()=>answer(false));
document.getElementById('form').addEventListener('submit',async event=>{event.preventDefault();const input=document.getElementById('prompt'),send=document.getElementById('send');if(!input.value.trim())return;send.disabled=true;
if(!pending||pending.text!==input.value)pending={id:crypto.randomUUID(),text:input.value};try{await request('/prompt',pending);input.value='';pending=null;error.textContent='';}catch(e){error.textContent=e.message+' · Send again to retry.';}finally{send.disabled=false;}});
document.getElementById('abort').addEventListener('click',async()=>{try{await request('/abort',{id:crypto.randomUUID()});error.textContent='';}catch(e){error.textContent=e.message;}});
if(token)poll();else{status.textContent='Access token required';error.textContent='Open the complete URL shown by /remote-control.';}
</script></html>`;
