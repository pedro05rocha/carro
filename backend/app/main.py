"""LIMO Fleet API. Telemetry and cmd_vel are proxied through this authenticated server."""
import asyncio, json, os, time, uuid
from contextlib import asynccontextmanager
from datetime import datetime, timezone, timedelta
from pathlib import Path
import jwt, websockets
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect, Depends, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from pydantic import BaseModel, Field, IPvAnyAddress
from prometheus_client import CONTENT_TYPE_LATEST, generate_latest
from .metrics import REGISTRY, refresh_metrics, remove_robot_metrics, CMD_VEL_COMMANDS, EMERGENCY_STOPS

SECRET=os.getenv('LIMO_SECRET_KEY','')
USER=os.getenv('LIMO_ADMIN_USER','admin'); PASSWORD=os.getenv('LIMO_ADMIN_PASSWORD','')
DB=Path(os.getenv('LIMO_DB','./robots.json')); security=HTTPBearer(auto_error=False)
TOPICS={'/scan':'sensor_msgs/msg/LaserScan','/imu':'sensor_msgs/msg/Imu','/odom':'nav_msgs/msg/Odometry','/limo_status':'limo_msgs/msg/LimoStatus'}
robots={}; listeners=set(); lease={'user':None,'robot':None,'until':0}; lock=asyncio.Lock()
class Login(BaseModel): username:str; password:str
class RobotIn(BaseModel): name:str=Field(min_length=1,max_length=48); host:IPvAnyAddress; port:int=Field(default=9090,ge=1,le=65535)
class Move(BaseModel): linear:float=Field(ge=-0.6,le=0.6); angular:float=Field(ge=-1.5,le=1.5)
class StopRequest(BaseModel): robot_id:str|None=None

def persist():
 DB.parent.mkdir(parents=True,exist_ok=True); DB.write_text(json.dumps([{k:r[k] for k in ('id','name','host','port','status')} for r in robots.values()],indent=2))
def claims(token):
 try:return jwt.decode(token,SECRET,algorithms=['HS256'])
 except Exception: raise HTTPException(401,'Sessão inválida ou expirada')
async def user_dep(c:HTTPAuthorizationCredentials|None=Depends(security)):
 if not c: raise HTTPException(401,'Autenticação necessária')
 return claims(c.credentials)['sub']
def make_token(user):return jwt.encode({'sub':user,'exp':datetime.now(timezone.utc)+timedelta(hours=8)},SECRET,algorithm='HS256')
async def publish(robot,topic,typ,msg):
 ws=robot.get('ws')
 if not ws or robot['status']!='connected': raise HTTPException(409,'Robô desligado; comando bloqueado')
 await ws.send(json.dumps({'op':'publish','topic':topic,'msg':msg,'type':typ}))
async def stop(robot):
 if robot.get('ws') and robot['status']=='connected':
  try: await publish(robot,'/cmd_vel','geometry_msgs/msg/Twist',{'linear':{'x':0,'y':0,'z':0},'angular':{'x':0,'y':0,'z':0}})
  except Exception: pass
async def ros_reader(rid):
 r=robots[rid]; url=f"ws://{r['host']}:{r['port']}"
 try:
  async with websockets.connect(url,open_timeout=5,ping_interval=10,ping_timeout=5,max_size=16*1024*1024) as ws:
   r['ws']=ws;r['status']='connected';r['connected_at']=time.time()
   for topic,typ in TOPICS.items(): await ws.send(json.dumps({'op':'subscribe','topic':topic,'type':typ,'throttle_rate':100,'queue_length':1}))
   async for raw in ws:
    m=json.loads(raw)
    if m.get('op')=='publish' and m.get('topic') in TOPICS:
     r['data'][m['topic']]=m.get('msg');r.setdefault('last_seen', {})[m['topic']]=time.time();r['updated_at']=datetime.now(timezone.utc).isoformat()
     event={'type':'telemetry','robot_id':rid,'data':{**r['data'],'updated_at':r['updated_at']}}
     for q in tuple(listeners):
      try:q.put_nowait(event)
      except asyncio.QueueFull: pass
 except asyncio.CancelledError: raise
 except Exception as e: r['status']='error';r['last_error']=str(e)
 finally:
  await stop(r)
  r['ws']=None
  if r['status']!='error':r['status']='offline'
  async with lock:
   if lease['robot']==rid:lease.update(user=None,robot=None,until=0)
  persist()

@asynccontextmanager
async def lifespan(app):
 if DB.exists():
  try:
   for x in json.loads(DB.read_text()): robots[x['id']]={**x,'status':'offline','data':{},'last_seen':{},'task':None,'ws':None}
  except Exception: pass
 async def watchdog():
  while True:
   await asyncio.sleep(.2)
   if lease['robot'] and time.monotonic()>lease['until']:
    r=robots.get(lease['robot']); lease.update(user=None,robot=None,until=0)
    if r: await stop(r)
 try: task=asyncio.create_task(watchdog());yield
 finally:
  task.cancel()
  for r in robots.values():
   await stop(r)
   if r.get('task'):r['task'].cancel()
app=FastAPI(title='LIMO Fleet API',version='1.0.0',lifespan=lifespan)
app.add_middleware(CORSMiddleware,allow_origins=os.getenv('CORS_ORIGINS','http://localhost:5173').split(','),allow_credentials=False,allow_methods=['*'],allow_headers=['*'])
@app.get('/api/health')
async def health():return {'status':'ok'}
@app.get('/metrics', include_in_schema=False)
async def prometheus_metrics():
 refresh_metrics(robots)
 return Response(generate_latest(REGISTRY), media_type=CONTENT_TYPE_LATEST)
@app.post('/api/login')
async def login(x:Login):
 if not SECRET: raise HTTPException(503,'Define LIMO_SECRET_KEY antes de iniciar o servidor')
 if not PASSWORD: raise HTTPException(503,'Define LIMO_ADMIN_PASSWORD antes de iniciar o servidor')
 if x.username!=USER or x.password!=PASSWORD:raise HTTPException(401,'Credenciais inválidas')
 return {'access_token':make_token(x.username),'token_type':'bearer'}
def public(r):return {k:r[k] for k in ('id','name','host','port','status')}|{'last_error':r.get('last_error')}
@app.get('/api/robots')
async def list_robots(_:str=Depends(user_dep)):return [public(r) for r in robots.values()]
@app.post('/api/robots')
async def add_robot(x:RobotIn,_:str=Depends(user_dep)):
 rid=str(uuid.uuid4());robots[rid]={'id':rid,'name':x.name,'host':str(x.host),'port':x.port,'status':'offline','data':{},'last_seen':{},'task':None,'ws':None};persist();return public(robots[rid])
def get_robot(rid):
 if rid not in robots:raise HTTPException(404,'Robô não encontrado')
 return robots[rid]
@app.delete('/api/robots/{rid}')
async def remove_robot(rid:str,_:str=Depends(user_dep)):
 r=get_robot(rid);await stop(r)
 if r.get('task'):r['task'].cancel()
 remove_robot_metrics(r);robots.pop(rid);persist();return {'ok':True}
@app.post('/api/robots/{rid}/connect')
async def connect(rid:str,_:str=Depends(user_dep)):
 r=get_robot(rid)
 if r.get('task') and not r['task'].done():return public(r)
 r['status']='connecting';r['last_error']=None;r['data']={};r['last_seen']={};r['task']=asyncio.create_task(ros_reader(rid));return public(r)
@app.post('/api/robots/{rid}/disconnect')
async def disconnect(rid:str,_:str=Depends(user_dep)):
 r=get_robot(rid);await stop(r)
 if r.get('task'):r['task'].cancel();r['task']=None
 r['status']='offline'
 async with lock:
  if lease['robot']==rid:lease.update(user=None,robot=None,until=0)
 return public(r)
@app.post('/api/robots/{rid}/control')
async def control(rid:str,x:Move,user:str=Depends(user_dep)):
 r=get_robot(rid)
 if r['status']!='connected':raise HTTPException(409,'Robô desligado; comando bloqueado')
 async with lock:
  if lease['until']>time.monotonic() and (lease['user']!=user or lease['robot']!=rid):raise HTTPException(423,'Outro utilizador controla um robô. Aguarda a libertação do controlo.')
  lease.update(user=user,robot=rid,until=time.monotonic()+.8)
 await publish(r,'/cmd_vel','geometry_msgs/msg/Twist',{'linear':{'x':x.linear,'y':0,'z':0},'angular':{'x':0,'y':0,'z':x.angular}})
 CMD_VEL_COMMANDS.labels(robot_id=r['id'],robot_name=r['name']).inc()
 return {'ok':True,'lease_ms':800}
@app.post('/api/emergency-stop')
async def emergency(x:StopRequest,user:str=Depends(user_dep)):
 targets=[get_robot(x.robot_id)] if x.robot_id else list(robots.values())
 async with lock:
  if x.robot_id is None or lease['robot']==x.robot_id:lease.update(user=None,robot=None,until=0)
 for r in targets:
  await stop(r)
  if r.get('ws') and r.get('status')=='connected':EMERGENCY_STOPS.labels(robot_id=r['id'],robot_name=r['name']).inc()
 return {'ok':True,'stopped':len(targets)}
@app.websocket('/ws')
async def telemetry(ws:WebSocket):
 token=ws.query_params.get('token','')
 try: user=claims(token)['sub']
 except HTTPException: await ws.close(code=4401);return
 await ws.accept();q=asyncio.Queue(maxsize=16);listeners.add(q)
 try:
  await ws.send_json({'type':'snapshot','robots':[public(r) for r in robots.values()]})
  while True:await ws.send_json(await q.get())
 except (WebSocketDisconnect,RuntimeError):pass
 finally:listeners.discard(q)


