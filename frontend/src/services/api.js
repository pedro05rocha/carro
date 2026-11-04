const BASE=import.meta.env.VITE_API_URL||'http://localhost:8000';
export const WS_BASE=BASE.replace(/^http/,'ws');
let token=()=>localStorage.getItem('token')||'';
export async function api(path,options={}){const response=await fetch(BASE+path,{...options,headers:{'Content-Type':'application/json',Authorization:`Bearer ${token()}`,...options.headers}});if(!response.ok){let detail=response.statusText;try{detail=(await response.json()).detail||detail}catch{}throw Error(detail)}return response.status===204?null:response.json()}
export async function login(credentials){const response=await fetch(BASE+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(credentials)});if(!response.ok)throw Error((await response.json()).detail||'Falha no acesso');return response.json()}
export const addRobot=form=>api('/api/robots',{method:'POST',body:JSON.stringify(form)});
export const connectRobot=id=>api(`/api/robots/${id}/connect`,{method:'POST'});
export const disconnectRobot=id=>api(`/api/robots/${id}/disconnect`,{method:'POST'});
export const deleteRobot=id=>api(`/api/robots/${id}`,{method:'DELETE'});
export const sendMove=(id,linear,angular)=>api(`/api/robots/${id}/control`,{method:'POST',body:JSON.stringify({linear,angular})});
export const emergencyStop=id=>api('/api/emergency-stop',{method:'POST',body:JSON.stringify({robot_id:id||null})});
