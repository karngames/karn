#!/usr/bin/env node
/* KARN LAN server — accounts, Elo, friends, notifications, saved matches,
   admin tools and metrics. Zero dependencies.
   Run:  node server.js   (optional: --port 8081)
   All data is stored in the ./data folder next to this file.
   THE FIRST ACCOUNT CREATED BECOMES THE ADMIN ACCOUNT.                    */
'use strict';
const http=require('http'),fs=require('fs'),path=require('path'),crypto=require('crypto'),os=require('os');

const argi=process.argv.indexOf('--port');
const PORT=argi>-1?+process.argv[argi+1]:(+process.env.PORT||8081); /* hosts like Railway set PORT */
const DIR=__dirname;
const DATA=path.join(DIR,'data');
fs.mkdirSync(DATA,{recursive:true});
const DBU=path.join(DATA,'users.json');
const DBM=path.join(DATA,'matches.json');
const DBX=path.join(DATA,'metrics.json');
const GAME=path.join(DIR,'karn.html');
const PNAMES=['White','Black'];

/* ---------- storage ---------- */
function readJSON(f){try{return JSON.parse(fs.readFileSync(f,'utf8'));}catch(e){return null;}}
let users=readJSON(DBU);
if(!users){ /* migrate from the old single-file layout if present */
  users=readJSON(path.join(DIR,'karn-users.json'))||{};
}
let saved=readJSON(DBM)||{};      /* finished match records */
let metrics=readJSON(DBX)||{firstStart:Date.now(),registrations:0,logins:0,gamesFinished:0,eventsRelayed:0};
const DBS=path.join(DATA,'misc.json');
let misc=readJSON(DBS)||{feedback:[],recov:{},fseq:1};
misc.support=misc.support||[];misc.smtp=misc.smtp||null;misc.tickets=misc.tickets||[];
/* per-DEVICE account tracking — deliberately not per network/IP so families
   sharing wifi are never affected. Max 5 accounts per device; banning a
   player can also block their device from creating new accounts.          */
misc.devices=misc.devices||{};
misc.knownIssues=misc.knownIssues||[];
misc.containers=misc.containers||[];  /* dev containers: private page forks, admin publishes */
misc.meetings=misc.meetings||[];      /* staff team room: chat + agenda + votes + decisions */
misc.dms=misc.dms||[];                /* private 1-on-1 management channels */
/* staff chain of command — the structure most companies run:
   individual contributors report to leads, leads to managers, managers to the top.
   rank: 0 player · 1 Trainee · 2 Staff · 3 Team Lead · 4 Manager · 5 Admin */
const RANK_NAMES=['Player','Trainee','Staff','Team Lead','Manager','Admin'];
function rankOf(x){return x.admin?5:(x.rank||(x.staff?2:0));}
const THEME_LIST=['default','sand','slate','crimson','midnight'];
const DEV_LIMIT=5;
function devOf(req){
  const d=String(req.headers['x-dev']||'').toLowerCase();
  return /^[a-f0-9]{16,40}$/.test(d)?d:null;
}
function devTouch(dev,user){
  if(!dev)return null;
  const keys=Object.keys(misc.devices);
  if(!misc.devices[dev]&&keys.length>2000)delete misc.devices[keys[0]];
  const D=misc.devices[dev]=misc.devices[dev]||{users:[],banned:false,bannedFor:[],ts:Date.now()};
  if(user&&!D.users.includes(user)){D.users.push(user);saveS();}
  return D;
}
misc.balance=misc.balance||null;misc.balV=misc.balV||0;
misc.pages=misc.pages||{custom:[],extends:{}};
function sanitizePages(pg){
  const out={custom:[],extends:{}};
  if(!pg||typeof pg!=='object')return out;
  const clean=list=>(Array.isArray(list)?list:[]).slice(0,16)
    .map(b=>{
      const o={title:String((b&&b.title)||'').slice(0,60),body:String((b&&b.body)||'').slice(0,5000)};
      if(b&&b.code)o.code=String(b.code).slice(0,20000);      /* JS code card (sandboxed on the client) */
      if(b&&b.h)o.h=Math.max(80,Math.min(900,+b.h||260));
      return o;
    });
  for(const p of(Array.isArray(pg.custom)?pg.custom:[]).slice(0,8)){
    const id=String((p&&p.id)||'').toLowerCase();
    if(!/^[a-z0-9]{2,12}$/.test(id)||out.custom.some(x=>x.id===id))continue;
    out.custom.push({id,title:String(p.title||id).slice(0,20),
      icon:String(p.icon||'📄').slice(0,4),
      vis:['all','users','staff','admin','dev'].includes(p.vis)?p.vis:'all',
      blocks:clean(p.blocks)});
  }
  for(const k of['rules','play','leaders','profile','notifs','friends','staff','admin'])
    if(pg.extends&&pg.extends[k])out.extends[k]=clean(pg.extends[k]);
  out.overrides={};
  for(const pk of['rules','play','leaders','profile','notifs','friends','staff','admin']){
    out.overrides[pk]={};
    if(!pg.overrides||!pg.overrides[pk])continue;
    let n=0;
    for(const k in pg.overrides[pk]){
      if(!/^[a-z0-9_]{2,20}$/.test(k)||++n>60)continue;
      const o=pg.overrides[pk][k]||{};
      out.overrides[pk][k]={title:String(o.title||'').slice(0,80),
        pre:String(o.pre||'').slice(0,5000),post:String(o.post||'').slice(0,5000),
        body:String(o.body||'').slice(0,8000),hide:o.hide?1:0};
    }
  }
  return out;
}
function balRule(k,dflt){const r=(misc.balance&&misc.balance.rules)||{};return Number.isFinite(+r[k])&&r[k]?+r[k]:dflt;}
const num=(v,lo,hi,dflt)=>{const n=Math.round(+v);return Number.isFinite(n)?Math.max(lo,Math.min(hi,n)):dflt;};
function sanitizeBalance(b){
  if(!b||typeof b!=='object')return null;
  const out={bases:{},guns:{},rules:{}};
  for(const k of['L','M','H']){
    const src=(b.bases||{})[k]||{};
    out.bases[k]={spd:num(src.spd,1,6,1),hp:num(src.hp,1,8,1),ap:num(src.ap,0,6,1)};
  }
  const guns=b.guns||{};
  let n=0;
  for(const id in guns){
    if(!/^[a-z0-9]{2,8}$/.test(id)||++n>12)continue;
    const g=guns[id]||{};
    out.guns[id]={name:String(g.name||id).slice(0,20),
      ap:num(g.ap,0,6,1),rng:num(g.rng,1,8,1),dmg:num(g.dmg,0,9,1),
      arc:g.arc?1:0};
    if(g.light)out.guns[id].light=1;
    if(g.heavy)out.guns[id].heavy=1;
    if(g.lvl)out.guns[id].lvl=2;
  }
  const r=b.rules||{};
  out.rules={actions:num(r.actions,1,6,3),perPiece:num(r.perPiece,1,6,2),
    armySize:num(r.armySize,4,10,8),maxPerType:num(r.maxPerType,1,10,4),
    snHeavyBonus:num(r.snHeavyBonus,0,3,1),dgAhead:num(r.dgAhead,1,9,4),
    eloK:num(r.eloK,8,64,32),drawRound:num(r.drawRound,50,500,150),
    setupSecs:num(r.setupSecs,30,900,240),idleSecs:num(r.idleSecs,10,300,30),
    deviceLimit:num(r.deviceLimit,1,50,5)};
  return out;
}
for(const tk of misc.tickets){  /* migrate one-shot tickets to threads + guest keys */
  if(!tk.messages)tk.messages=[{by:tk.from,text:tk.body||'',ts:tk.ts}];
  if(!tk.key)tk.key=crypto.randomBytes(16).toString('hex');
}
function ticketLink(tk,req){
  return(typeof IS_TLS!=='undefined'&&IS_TLS?'https':'http')+'://'+
    ((req&&req.headers.host)||'localhost:'+PORT)+'/?ticket='+tk.key;
}
function makeRecovery(user,by){
  const code=crypto.randomBytes(4).toString('hex').toUpperCase();
  misc.recov[code]={user,by:by||'auto-email',exp:Date.now()+30*60e3};
  saveS();
  return code;
}

/* ============ KARN ASSISTANT — automated support agent ============
   Triages every support ticket by intent, takes action where it can
   (recovery codes, escalations, bug routing), follows up on replies,
   and always hands over to a human on request.                       */
const BOT='KARN Assistant';
function agentSay(tk,text,req,extras){
  tk.messages.push({by:BOT,text,ts:Date.now()});
  tk.botReplies=(tk.botReplies||0)+1;
  saveS();
  if(users[tk.to]){
    addNotif(tk.to,{type:'ticket',from:BOT,data:{tid:tk.id},
      text:`${BOT} replied to ticket #${tk.id}`});
    sendUserMail(tk.to,`[KARN Support] Re: Ticket #${tk.id} — ${tk.subject}`,
      `Ticket #${tk.id} — new reply`,
      text+'\n\nYou can read the whole conversation and reply using the button below — no login needed.',
      'Reply "human" at any time to reach a real staff member.',
      Object.assign({link:{label:'Open your ticket',url:ticketLink(tk,req)}},extras||{}));
  }
}
function agentEscalate(tk,why){
  tk.human=true;
  bumpPriority(tk,/ban|cheat|report|deletion|security/.test(why)?'high':'normal');
  saveS();
  agentReport(tk,why);
  notifyAdmins(`🙋 Ticket #${tk.id} (${tk.to}) needs a HUMAN [${(tk.priority||'normal').toUpperCase()}]: ${why}`);
}
/* --- knowledge base for instant gameplay answers --- */
const KB=[
 [/snip/i,'Snipers mount only on Light hulls (1 slot) and slow them to speed 1. They fire down the single line they face: range 4 for −1 HP, and they shoot PAST other tanks — only walls stop them. They also do +1 damage to Heavies. At Level 2 they upgrade to Double Snipers: range 5, −2 HP.'],
 [/dirt/i,'The Dirt Gun is a Level 2, Heavy-only weapon (2 slots). Range 1 but ALL 8 squares around the tank — including behind. It hits for −4 HP dead ahead (one-shots most tanks) and −1 everywhere else.'],
 [/big gun/i,'The Big Gun costs 2 slots: 180° front arc, range 2, −2 HP per hit — the go-to weapon for cracking armoured tanks.'],
 [/small gun/i,'The Small Gun costs 1 slot: 180° front arc, range 1, −1 HP. Cheap — which leaves room for armour.'],
 [/armou?r/i,'Armour costs 1 slot and adds +1 HP, stacking. It shows as rings on the hull. Watch out: snipers do +1 damage to Heavies, armoured or not.'],
 [/boost|speed/i,'The Speed Boost unlocks at Level 2: +1 speed for 1 slot, on Medium and Heavy hulls only (never Lights). Gold chevrons on the hull.'],
 [/level ?2/i,'You reach Level 2 the first time one of your pieces touches the enemy back rank. It unlocks Double Snipers, the Dirt Gun, and Speed Boosts — fitted by refitting a piece while it sits on your own back rank (refits are free).'],
 [/wall|setup|deploy/i,'Setup: 6 shared centre walls (pick 3 columns; the other row is the same or mirrored — 112 legal layouts), then each side places 4 walls in their first three rows (never the back rank) and deploys 8 tanks, max 4 per class.'],
 [/elo|rating|rank/i,'Ratings start at 1000 and move with each match (K-factor 32 by default — beating a stronger player earns more). The queue matches you within 150 Elo instantly, widening to anyone after 10 seconds.'],
 [/draw|resign/i,'During an online match use the 🤝 button to offer a draw (your opponent can accept or decline) and 🏳 to resign — with a confirmation so no accidents.'],
 [/refit|workshop|armoury|loadout/i,'A tank can be refitted — guns, armour, boost swapped freely — only while it sits on YOUR back rank. Refits are free and instant; drive off the rank and the loadout is locked in.'],
 [/replay|review/i,'Every finished online match is saved. Open it from a profile and hit Review — the engine grades every move (best / good / inaccuracy / mistake / blunder) and shows what it would have played.'],
 [/\bmov(e|es|ing|ement)\b|how.*(far|fast).*(tank|piece)/i,'Movement: a tank drives in a straight line in the direction it faces, up to its speed — Light 3, Medium 2, Heavy 1 (a Speed Boost adds +1; snipers are always speed 1). Moving any distance costs 1 action. You get 3 actions per turn, max 2 on the same piece. To change direction, spend an action turning (any of the 8 facings). Tanks with destroyed tracks cannot move or turn until repaired.'],
 [/\bturn(ing)?\b.*(face|facing|direction|rotate)|rotate|facing/i,'Turning: spending 1 action lets a tank face any of the 8 directions. Facing matters — guns fire into the arc the tank faces, and tanks can only drive straight ahead. A tank with destroyed tracks cannot turn until repaired.'],
 [/\bactions?\b.*(turn|many|per)|per turn/i,'You get 3 actions per turn. Moving, turning, shooting and repairing each cost 1 action, and no single piece may take more than 2 actions in a turn. Refitting on your back rank is free.'],
 [/line of sight|\blos\b|shoot|shooting|\bfire\b|\bfiring\b/i,'Shooting: guns fire in straight or diagonal lines, like a chess queen. Every square between shooter and target must be empty — walls and tanks block the shot (exception: snipers shoot past tanks; only walls stop them). Any shot can instead target the TRACKS to immobilise the victim.'],
 [/track|immobil|repair/i,'Track shots: any gun can shoot a tank\'s tracks instead of its hull. A tracked tank cannot move OR turn until its owner spends an action repairing it — and it only rolls again the round after the repair.'],
 [/sound|audio|volume|mute|sfx/i,'Piece sounds can be turned on or off any time: open your 👤 Profile page and use the 🔊 Piece sounds toggle under Personalisation. The setting is remembered on your device.'],
 [/theme|board colou?r|design|skin|personali[sz]/i,'Board themes: your 👤 Profile page has a Personalisation section with 5 board designs — Emerald (default), Desert Sand, Slate, Crimson and Midnight. Pick one and it applies instantly and saves to your account. You can also just tell me which one you want and I\'ll switch it for you.'],
 [/win|goal|objective/i,'Two ways to win: destroy every enemy piece, or hold BOTH gold ◇ squares in the middle of the enemy back rank with two of your tanks at once.'],
];
const PRI_RANK={low:0,normal:1,high:2,urgent:3};
function bumpPriority(tk,p){
  if((PRI_RANK[p]||0)>(PRI_RANK[tk.priority||'low']||0)){tk.priority=p;saveS();}
}
function agentReport(tk,reason){
  const u=users[tk.to];
  const stmts=tk.messages.filter(m=>m.by===tk.to).map(m=>'  - '+m.text.slice(0,140));
  const rec=/ban/.test(reason)?'Review the ban reason and match history, then reply on the ticket; unban from User management if justified.'
    :/report|cheat/.test(reason)?'Check the flagged account\'s recent replays (Game Review helps); warn, tag or ban as appropriate.'
    :/recovery|password|email/.test(reason)?'Create a recovery code from the Staff page and post it on this ticket.'
    :/deletion/.test(reason)?'Confirm identity on the ticket, then delete the account from User management.'
    :'Read the thread and take over the conversation.';
  tk.notes=tk.notes||[];
  tk.notes.push({by:BOT,ts:Date.now(),text:
    'CASE REPORT — ticket #'+tk.id+'\n'+
    'Player: '+tk.to+' ('+(u?('Elo '+u.elo+', '+(u.banned?'BANNED':'active')+', '+u.games+' games'):'account missing')+')\n'+
    'Priority: '+(tk.priority||'normal')+'\n'+
    'Escalated because: '+reason+'\n'+
    'Player statements:\n'+(stmts.join('\n')||'  (none)')+'\n'+
    'Recommended action: '+rec});
  saveS();
}
function isNonsense(t){
  const raw=String(t||'').trim();
  if(raw.length<6)return true;
  if(/(.)\1{4,}/.test(raw))return true;
  const sLow=raw.toLowerCase().replace(/[^a-z ]/g,' ');
  const words=sLow.split(/\s+/).filter(Boolean);
  if(!words.length)return true;
  const COMMON=new Set(('the a i my me is it of to and for in on you your help please with game account password login ban banned name user tank sniper gun wall play match elo cant can not work bug error broken how what why when where does do want need lost forgot change stuck report player friend email code level board').split(' '));
  const real=words.filter(w=>COMMON.has(w)||(w.length>=3&&/[aeiou]/.test(w)&&!/^(asdf|qwer|zxcv|hjkl|wasd|sdfg|dfgh|fghj)/.test(w)&&!/(.)\1{2,}/.test(w)));
  if(raw.length<90&&real.length<Math.max(1,Math.ceil(words.length*0.34)))return true;
  /* readable but with no support-relevant content ("i like cheese lol") */
  const TOPIC=new Set(('help password login log ban banned unban account bug error broken crash crashes freeze freezes frozen load loads loading stuck board game match tank sniper gun wall piece pieces move moves moving turn shoot shooting elo rating rank friend request email mail code recovery reset name username change theme colour color colors colours design sound sounds profile private public setting settings work works working worked cant wont doesnt didnt isnt screen phone mobile tablet click clicking button page slow lag laggy disconnect disconnected connection server ticket staff human person report cheat cheater cheating hack hacked delete deletion question how why rule rules play playing problem issue wrong fix fixed broke support armor armour module upgrade level damage shot shots range win lose lost losing draw forfeit timer clock replay review army setup thanks thank cheers solved sorted resolved good great okay ok done bye password').split(' '));
  if(raw.length<120&&!words.some(w=>TOPIC.has(w)))return true;
  return false;
}
function sigWords(t){
  const stop=new Set(('the a is it to and for of in on my i you your with game that this when have has bug error broken not work its very just really').split(' '));
  return [...new Set(String(t).toLowerCase().replace(/[^a-z ]/g,' ').split(/\s+/)
    .filter(w=>w.length>3&&!stop.has(w)))].slice(0,8);
}
function matchKI(ws){
  return misc.knownIssues.find(k=>k.status==='open'&&k.sig.filter(w=>ws.includes(w)).length>=2);
}
function agentHandle(tk,msg,req){
  if(tk.from!=='support'||tk.human||tk.status!=='open')return;
  if((tk.botReplies||0)>=6){
    agentEscalate(tk,'conversation limit reached');
    agentSay(tk,`I've done what I can automatically, so I'm handing this over to the staff team — a real person will pick it up from here. Thanks for your patience!`,req);
    return;
  }
  const m=String(msg||'').toLowerCase();
  const u=users[tk.to];
  const st=tk.agent=tk.agent||{codes:0};
  const has=re=>re.test(m);
  /* ---- joke / gibberish filter ---- */
  if(isNonsense(msg)){
    st.nonsense=(st.nonsense||0)+1;
    if(st.nonsense>=2){
      tk.messages.push({by:BOT,text:`This ticket has been closed as no actionable support request was received. You're welcome to open a new ticket at any time — just include a short description of the problem.`,ts:Date.now()});
      tk.status='closed';tk.closedBy=BOT;saveS();
      if(users[tk.to])addNotif(tk.to,{type:'info',text:`Ticket #${tk.id} was closed as it did not contain an actionable support request. You're welcome to open a new one at any time.`});
      return;
    }
    saveS();
    agentSay(tk,`Thanks for getting in touch. I wasn't able to identify a support request in this message, so I haven't opened an investigation. If you do need help, reply with a brief description of the problem or question — for example "I forgot my password" or "the board doesn't load on my phone" — and I'll get straight onto it. Please note that if the next message also contains no clear request, this ticket will be closed automatically.`,req);
    return;
  }
  /* ---- multi-intent detection ---- */
  const wantHuman=has(/\b(human|person|real staff|agent|someone real|speak to (a )?(person|staff|admin)|talk to (a )?(person|staff|admin))\b/);
  const thanks=has(/\b(thanks|thank you|solved|fixed|sorted|works now|all good|resolved)\b/);
  const iBan=has(/\b(ban|banned|unban|suspend|suspension|appeal)\b/);
  const iPass=has(/\b(password|passw|log ?in|locked|forgot|sign ?in|can'?t get in|cant get in)\b/);
  const iName=has(/\b(username|user name|rename|change (my )?name)\b/);
  const iBug=has(/\b(bug|error|broken|glitch|crash|freez|stuck|not work|lag)\b/);
  const iCheat=has(/\b(cheat|cheater|hack|exploit|report (a |this )?player|abusive|harass)\b/);
  const iDelete=has(/\b(delete|remove|close) (my )?account\b/);
  const angry=has(/\b(ridiculous|unfair|furious|angry|scam|terrible|awful|joke)\b/)||/!{2,}/.test(m);
  const kbHit=KB.find(([re])=>re.test(m));
  const isQuestion=/\bhow|what|why|when|where|which|does|can i|can you|explain|rule|question|tell me|\?/.test(m)||m.split(/\s+/).length<=6;
  const anyIssue=iBan||iPass||iName||iBug||iCheat||iDelete;
  /* explicit human request always wins */
  if(wantHuman){
    agentEscalate(tk,'user requested a human');
    agentSay(tk,`Of course — I've flagged this ticket for the staff team and stepped aside. A real person will reply here as soon as they're available. Everything you've written above is already with them, so there's no need to repeat yourself.`,req);
    return;
  }
  if(thanks&&!anyIssue){
    tk.status='closed';tk.closedBy=BOT;saveS();
    if(users[tk.to])addNotif(tk.to,{type:'info',text:`Ticket #${tk.id} closed — glad it's sorted!`});
    agentSayClosed(tk,req);
    return;
  }
  /* ---- compose one reply that covers everything detected ---- */
  const parts=[];const extras={};
  if(angry)parts.push(`I can hear this has been frustrating — sorry about that. Let's get it fixed.`);
  /* ---- direct changes to simple user settings ---- */
  let didSettings=false;
  if(u){
    const wantsOff=/\b(off|stop|disable|unsubscribe|no more)\b/.test(m);
    const wantsOn=/\b(back on|enable|turn on|start)\b/.test(m);
    if(/friend request/.test(m)&&/email/.test(m)&&(wantsOff||wantsOn)){
      u.emailPrefs.friendReq=wantsOff?false:true;
      saveU();didSettings=true;
      parts.push(`Done — friend-request emails are now ${u.emailPrefs.friendReq?'ON':'OFF'} for your account. (Security and staff emails always stay on.) You can also flip this on your Profile page.`);
    }
    if(/profile/.test(m)&&/\bprivate\b/.test(m)){
      u.private=true;saveU();didSettings=true;
      parts.push(`Your profile is now PRIVATE — only you and staff can see your match history.`);
    }else if(/profile/.test(m)&&/\bpublic\b/.test(m)){
      u.private=false;saveU();didSettings=true;
      parts.push(`Your profile is now PUBLIC — other players can browse your match history and replays.`);
    }
    if(/(theme|board|colou?r|design|skin)/.test(m)){
      const thm=THEME_LIST.find(t2=>m.includes(t2));
      if(thm){
        u.theme=thm;saveU();didSettings=true;
        parts.push(`Board theme switched to "${thm}" — you'll see it when you reload the game. All the designs are on your Profile page too.`);
      }
    }
  }
  if(iBan){
    agentEscalate(tk,'ban appeal — only the admin can lift bans');
    parts.push(`About the suspension: account bans can only be lifted by the server administrator, so I've escalated your appeal to them directly with everything you've written here. They'll reply on this ticket, and you'll get an email the moment they do.`);
  }
  if(iCheat){
    agentEscalate(tk,'player report: "'+String(msg).slice(0,80)+'"');
    const accused=Object.keys(users).find(n=>n.toLowerCase()!==tk.to.toLowerCase()&&m.includes(n.toLowerCase()));
    if(accused&&users[accused]){
      users[accused].flagged={by:BOT,note:'reported in ticket #'+tk.id+' by '+tk.to,ts:Date.now()};saveU();
      parts.push(`Thanks for the report about ${accused} — I've flagged their account for admin review and passed along your exact words. The admin will look at their match history and take it from there.`);
    }else{
      parts.push(`Thanks for the report — I've escalated it to the admin with your exact words. If you can, reply with the player's exact username so they can pull the right match history.`);
    }
  }
  if(iPass||iName){
    bumpPriority(tk,'normal');
    const what=iPass&&iName?'reset your password and change your username':iPass?'reset your password':'change your username';
    if(u&&u.email&&misc.smtp&&misc.smtp.host){
      extras.code=makeRecovery(tk.to);
      st.codes++;
      parts.push((st.codes>1?`Here's a fresh code (that's number ${st.codes} — if these aren't reaching you, check your spam folder, or reply "human"). `:``)+
        `To ${what}: open the KARN site, click "Account recovery" on the login screen, enter the code below, then set a new password${iName?' and type your new username in the optional field':''}. The code works once and expires in 30 minutes.`);
    }else{
      agentEscalate(tk,'account recovery needed but no recovery email is linked');
      parts.push(`To ${what} I'd normally email you a recovery code, but this account has no recovery email linked${misc.smtp&&misc.smtp.host?'':' (or the email service is offline)'} — so I've asked the staff team to generate one manually. They'll post it right here.`);
    }
  }
  if(iBug){
    bumpPriority(tk,'normal');
    const ws=sigWords(msg);tk.bugSig=ws;
    let ki=matchKI(ws);
    if(!ki){
      /* two similar fresh reports promote into a known problem */
      const twin=misc.tickets.find(o=>o.id!==tk.id&&o.from==='support'&&o.bugSig&&Date.now()-o.ts<48*3600e3&&o.bugSig.filter(w=>ws.includes(w)).length>=2);
      if(twin){
        ki={id:misc.fseq++,sig:[...new Set([...ws,...twin.bugSig])].slice(0,10),
          title:ws.slice(0,3).join(' '),count:1,tids:[twin.id],ts:Date.now(),status:'open'};
        misc.knownIssues.push(ki);twin.knownOf=ki.id;
        notifyAdmins(`📌 New known problem KP-${ki.id}: "${ki.title}" (multiple similar reports)`);
      }
    }
    if(ki){
      ki.count++;ki.tids.push(tk.id);tk.knownOf=ki.id;
      bumpPriority(tk,ki.count>=3?'high':'normal');
      if(ki.count===3)notifyAdmins(`📈 Known problem KP-${ki.id} ("${ki.title}") is trending — ${ki.count} reports`);
      saveS();
      parts.push(`This matches a problem we're already tracking (KP-${ki.id} — "${ki.title}", ${ki.count} reports so far), so I've merged your ticket into it. You'll be notified the moment it's fixed.`);
    }else{
      misc.feedback.unshift({id:misc.fseq++,from:tk.to,text:'[via support ticket #'+tk.id+'] '+String(msg).slice(0,900),ts:Date.now()});
      if(misc.feedback.length>200)misc.feedback.length=200;
      saveS();
      notifyAdmins(`🐛 Bug report from ticket #${tk.id} (${tk.to}) filed to the feedback inbox`);
      parts.push(`I've filed your bug report word-for-word in the admin's inbox so nothing gets lost. Anything that helps reproduce it (what you clicked, what you expected, what happened) — just reply here and I'll attach it.`);
    }
  }
  if(iDelete){
    agentEscalate(tk,'account deletion request');
    parts.push(`Account deletion has to be done by the administrator — I've passed your request straight to them. They'll confirm on this ticket before anything is removed.`);
  }
  if(!anyIssue&&!didSettings&&kbHit&&isQuestion){bumpPriority(tk,'low');
    parts.push(kbHit[1]);
    parts.push(`Anything else you'd like to know? The 📖 Rules page in the game covers everything with live diagrams — or reply "human" for a real person.`);
  }
  if(!parts.length){
    st.confused=(st.confused||0)+1;
    if(st.confused>=3){
      agentEscalate(tk,'assistant could not resolve after several attempts');
      parts.push(`I clearly haven't been able to help with this one, so I've handed your ticket to the staff team with a full summary — a real person will reply here. Sorry for the run-around, and thanks for bearing with me.`);
    }else if(st.confused===2){
      parts.push(`Sorry — I'm still not following. In one short sentence, what would you like to happen? For example: "explain how movement works", "turn off friend request emails", "reset my password". If I miss again I'll bring in a member of staff, or reply "human" to skip straight to them.`);
    }else{
      parts.push(`Thanks for getting in touch — I'm the automated KARN assistant and I resolve most requests instantly. You wrote: "${String(msg).slice(0,120)}" — could you tell me a little more?\n\nHere's what I can do right away:\n• "I forgot my password" — I'll email you a recovery code\n• "I want to change my username" — recovery code for that too\n• "I've been banned" — I'll escalate your appeal to the admin\n• "I found a bug" or "report a player" — filed straight to the admin\n• Rules questions ("how does moving work?") — instant answer\n• Settings ("turn off friend request emails", "make my profile private", "switch my theme to crimson")\n\nOr reply "human" and I'll hand you to the staff team.`);
    }
    saveS();
  }else st.confused=0;
  agentSay(tk,parts.join('\n\n'),req,extras);
}
function agentSayClosed(tk,req){
  if(users[tk.to])
    sendUserMail(tk.to,`[KARN Support] Ticket #${tk.id} resolved`,
      `Ticket #${tk.id} — resolved`,
      `Glad we could help! This ticket is now closed.\n\nIf anything else comes up, open a new request via Support on the login screen, or the Feedback button in the game.\n\nSee you on the battlefield!`,
      'A staff member can reopen this ticket at any time if needed.');
}
/* auto-close bot-resolved tickets that have gone quiet for 24h */
setInterval(()=>{
  const now=Date.now();
  for(const tk of misc.tickets){
    if(tk.status!=='open'||tk.from!=='support'||tk.human)continue;
    const last=tk.messages[tk.messages.length-1];
    if(last&&last.by===BOT&&now-last.ts>24*3600e3){
      tk.status='closed';tk.closedBy=BOT;saveS();
      if(users[tk.to])addNotif(tk.to,{type:'info',
        text:`Ticket #${tk.id} auto-closed after 24h of quiet — reply via Support to reopen the conversation`});
    }
  }
},10*60e3);
let nseq=1;
/* per-account login lockout (in memory) + emailed one-time login links */
const lockouts={};
const loginKeys={};
function maybeMailLoginLink(u,req){
  const lo=lockouts[u];
  if(!lo)return false;
  if(lo.mailed)return true;
  const x=users[u];
  if(!x||!x.email||!misc.smtp||!misc.smtp.host)return false;
  const k=crypto.randomBytes(20).toString('hex');
  loginKeys[k]={user:u,exp:Date.now()+15*60e3};
  const link=(typeof IS_TLS!=='undefined'&&IS_TLS?'https':'http')+'://'+
    (req.headers.host||'localhost:'+PORT)+'/?loginkey='+k;
  sendUserMail(u,'[KARN] One-time login link','Locked out? Here is a direct way in',
    `Someone (hopefully you) tried to log in to "${u}" too many times, so the account is temporarily locked.\n\nIf it was you, the button below logs you straight in — it works once and expires in 15 minutes. Using it clears the lock immediately.\n\nIf this wasn't you, your password held firm — but consider changing it once you're back in.`,
    'Not you? You can safely ignore this email.',
    {link:{label:'🔓 Log me in',url:link}});
  lo.mailed=true;
  return true;
}
function maskEmail(e){const i=e.indexOf('@');return e[0]+'***'+(i>-1?e.slice(i):'');}
/* minimal SMTP-over-SSL client (port 465, AUTH LOGIN — e.g. Gmail app password) */
/* SendGrid HTTP API — for hosts (Railway, Render, Fly…) that block outbound
   SMTP entirely. Auto-used when the saved key starts with "SG.".            */
function sendViaSendGrid(to,subject,text,html){
  return new Promise((resolve,reject)=>{
    const cfg=misc.smtp||{};
    const content=[{type:'text/plain',value:text}];
    if(html)content.push({type:'text/html',value:html});
    const payload=JSON.stringify({
      personalizations:[{to:[{email:to}]}],
      from:{email:cfg.from||cfg.user,name:'KARN'},
      subject,
      content
    });
    const req2=require('https').request({
      host:'api.sendgrid.com',port:443,path:'/v3/mail/send',method:'POST',
      headers:{'Authorization':'Bearer '+cfg.pass,'Content-Type':'application/json',
        'Content-Length':Buffer.byteLength(payload)},
      timeout:10000
    },res2=>{
      let b='';res2.on('data',d=>b+=d);
      res2.on('end',()=>{
        if(res2.statusCode>=200&&res2.statusCode<300)return resolve(true);
        if(res2.statusCode===401)return reject(new Error('SendGrid rejected the API key — check it starts with SG. and is active'));
        if(res2.statusCode===403)return reject(new Error('SendGrid refused the sender address — verify "'+(cfg.from||cfg.user)+'" as a Single Sender or authenticated domain in SendGrid'));
        reject(new Error('SendGrid error '+res2.statusCode+': '+b.slice(0,140)));
      });
    });
    req2.on('timeout',()=>{req2.destroy(new Error('SendGrid API timeout'));});
    req2.on('error',e=>reject(new Error('SendGrid connection failed: '+e.message)));
    req2.end(payload);
  });
}
function sendMail(to,subject,text,html){
  const cfg=misc.smtp||{};
  if(cfg.pass&&String(cfg.pass).startsWith('SG.'))return sendViaSendGrid(to,subject,text,html);
  return new Promise((resolve,reject)=>{
    if(!cfg.host||!cfg.user)return reject(new Error('Email service not configured'));
    let sock;
    try{
      const port=+cfg.port||465;
      sock=cfg.plain    /* plain TCP for local relays / testing only */
        ?require('net').connect({host:cfg.host,port})
        :require('tls').connect({host:cfg.host,port,servername:cfg.host});
    }catch(e){return reject(e);}
    const from=cfg.from||cfg.user;
    const b64=s=>Buffer.from(String(s)).toString('base64');
    const steps=[
      {expect:220,send:'EHLO karnserver'},
      {expect:250,send:'AUTH LOGIN'},
      {expect:334,send:b64(cfg.user)},
      {expect:334,send:b64(cfg.pass)},
      {expect:235,send:`MAIL FROM:<${from}>`},
      {expect:250,send:`RCPT TO:<${to}>`},
      {expect:250,send:'DATA'},
      {expect:354,send:(html?[
        `From: KARN <${from}>`,`To: <${to}>`,`Subject: ${subject}`,
        'MIME-Version: 1.0','Content-Type: multipart/alternative; boundary="k4rnB0und"','',
        '--k4rnB0und','Content-Type: text/plain; charset=utf-8','',text,'',
        '--k4rnB0und','Content-Type: text/html; charset=utf-8','',html,'',
        '--k4rnB0und--','.']
       :[`From: KARN <${from}>`,`To: <${to}>`,`Subject: ${subject}`,
        'MIME-Version: 1.0','Content-Type: text/plain; charset=utf-8','',text,'.']).join('\r\n')},
      {expect:250,send:'QUIT'},
      {expect:221,send:null}
    ];
    let idx=0,buf='',done=false;
    const nice=e=>{
      const m=String(e&&e.message||e);
      if(/ENOTFOUND|EAI_AGAIN/.test(m))return new Error('SMTP host not found — it must be a mail server name like smtp.gmail.com (not an email address)');
      if(/ECONNREFUSED/.test(m))return new Error('The mail server refused the connection — check the host and port (465)');
      if(/timeout/i.test(m))return new Error('The mail server did not respond — check the host, and that port 465 (SSL) is right for your provider');
      if(/535|534/.test(m))return new Error('Login refused by the mail server — check the email and app password (Google needs 2-step verification + an app password, not your normal password)');
      return e;
    };
    const finish=err=>{if(done)return;done=true;try{sock.destroy();}catch(_){}err?reject(nice(err)):resolve(true);};
    sock.setTimeout(10000,()=>finish(new Error('SMTP timeout')));
    sock.on('error',e=>finish(e));
    sock.on('data',d=>{
      buf+=d.toString();
      if(!/\r?\n$/.test(buf))return;          /* wait for a complete line */
      const lines=buf.split(/\r?\n/);
      for(let i=lines.length-1;i>=0;i--){
        const L=lines[i];
        if(!L)continue;
        if(/^\d{3} /.test(L)){
          const codeN=+L.slice(0,3);buf='';
          const st=steps[idx];
          if(!st)return finish();
          if(codeN!==st.expect)return finish(new Error('SMTP '+codeN+': '+L.slice(4,120)));
          idx++;
          if(st.send!=null)sock.write(st.send+'\r\n');
          else finish();
        }
        break;
      }
    });
  });
}
const ADMIN_NAMES=['rubenhillier'];   /* these usernames are ALWAYS admins */
for(const u in users){ /* ensure new fields exist on old accounts — never deletes anything */
  const x=users[u];
  x.friends=x.friends||[];x.reqIn=x.reqIn||[];x.reqOut=x.reqOut||[];
  x.blocked=x.blocked||[];x.matches=x.matches||[];
  x.notifs=(x.notifs||[]).map(n=>n.type?n:{...n,type:'info',from:null,data:null});
  x.private=!!x.private;x.admin=!!x.admin;x.staff=!!x.staff;x.dev=!!x.dev;
  x.rank=x.rank||(x.staff?2:0);x.manager=x.manager||null;
  x.banned=x.banned||null;x.flagged=x.flagged||null;
  x.emailPrefs=x.emailPrefs||{friendReq:true};
  if(ADMIN_NAMES.includes(u.toLowerCase())&&!x.admin){
    x.admin=true;
    console.log('granted admin to existing account:',u);
  }
}
if(Object.keys(users).length)setTimeout(()=>save(DBU,users),400); /* persist any admin grants */
const savers={};
function save(file,obj){
  if(savers[file])return;
  savers[file]=setTimeout(()=>{delete savers[file];
    try{fs.writeFileSync(file,JSON.stringify(obj,null,1));}catch(e){console.error('save failed:',e.message);}
  },250);
}
const saveU=()=>save(DBU,users),saveM=()=>save(DBM,saved),saveX=()=>save(DBX,metrics),saveS=()=>save(DBS,misc);

/* ============ ENCRYPTED CREDENTIAL VAULT (admin-only) ============
   Stores business email logins encrypted with AES-256-GCM. The key is
   derived from a master passphrase via scrypt and is NEVER written to disk;
   it lives only in memory for the duration of an unlocked admin session.
   The passphrase itself is never stored — losing it means the data is
   unrecoverable, which is the point.                                       */
const DBV=path.join(DATA,'vault.json');
let vaultFile=readJSON(DBV);          /* {salt, iv, tag, ct} or null */
const vaultKeys={};                   /* token -> derived key (Buffer)     */
function deriveVaultKey(pass,salt){return crypto.scryptSync(pass,salt,32,{N:16384,r:8,p:1});}
function vaultDecrypt(key){
  const iv=Buffer.from(vaultFile.iv,'hex'),tag=Buffer.from(vaultFile.tag,'hex');
  const d=crypto.createDecipheriv('aes-256-gcm',key,iv);
  d.setAuthTag(tag);
  const pt=Buffer.concat([d.update(Buffer.from(vaultFile.ct,'hex')),d.final()]);
  return JSON.parse(pt.toString('utf8'));
}
function vaultEncrypt(key,entries){
  const iv=crypto.randomBytes(12);
  const c=crypto.createCipheriv('aes-256-gcm',key,iv);
  const ct=Buffer.concat([c.update(Buffer.from(JSON.stringify(entries),'utf8')),c.final()]);
  vaultFile={v:1,salt:vaultFile.salt,iv:iv.toString('hex'),tag:c.getAuthTag().toString('hex'),ct:ct.toString('hex')};
  /* write synchronously — credentials must never be lost to a debounce window */
  fs.writeFileSync(DBV,JSON.stringify(vaultFile));
}
function vaultRedact(entries){
  return entries.map(e=>({id:e.id,label:e.label,email:e.email,notes:e.notes,updated:e.updated,hasPass:!!e.pass}));
}
function notifyAdmins(text){
  for(const u in users)if(users[u].admin)addNotif(u,{type:'info',text});
}
/* ---- outbound email: branded HTML + plaintext fallback ---- */
const mailLog=[];
let PUBLIC_BASE='';                       /* learned from incoming requests */
function mailTemplate(title,name,body,footer,extras){
  const x=extras||{};
  const lines=['KARN — BATTLEFIELD COMMAND','═'.repeat(46),'',title.toUpperCase(),'',
    `Hi ${name},`,'',body];
  if(x.code)lines.push('','    ┌──────────────────┐',`    │   ${x.code}   │`,'    └──────────────────┘');
  if(x.link)lines.push('',`${x.link.label}:`,`    ${x.link.url}`);
  lines.push('','─'.repeat(46),
    footer||'This is an automated message from your KARN game server.',
    'Please do not reply directly to this email.');
  return lines.join('\n');
}
function esc(t){return String(t).replace(/&/g,'&amp;').replace(/</g,'&lt;');}
function logoExists(){try{return fs.statSync(path.join(DIR,'karn-logo.jpg')).size>2048;}catch(e){return false;}}
function mailHTML(title,name,body,footer,extras){
  const x=extras||{};
  /* big square logos are cropped to a centered banner via background-cover */
  const logo=(PUBLIC_BASE&&logoExists())?`<div style="height:190px;background:url('${PUBLIC_BASE}/logo.jpg') center center/cover no-repeat #0d1a14;border-radius:12px 12px 0 0;font-size:0">&nbsp;</div>`
    :`<div style="padding:34px 20px 26px;text-align:center;background:#0d1a14;border-radius:12px 12px 0 0">
        <div style="font-family:Georgia,serif;font-size:40px;letter-spacing:14px;color:#dfb257;font-weight:bold">KARN</div>
        <div style="font-family:Helvetica,Arial,sans-serif;font-size:11px;letter-spacing:6px;color:#9fb3a6;margin-top:4px">BATTLEFIELD&nbsp;COMMAND</div></div>`;
  const codeBox=x.code?`
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:18px 0 6px">
      <table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="border:2px dashed #dfb257;border-radius:12px;background:#0d1a14;padding:16px 34px;font-family:'Courier New',monospace;font-size:30px;letter-spacing:8px;color:#f2d489;font-weight:bold">${esc(x.code)}</td></tr></table>
      <div style="font-family:Helvetica,Arial,sans-serif;font-size:11px;color:#8aa294;padding-top:8px">One-time code · expires in 30 minutes</div>
    </td></tr></table>`:'';
  const button=x.link?`
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:16px 0 6px">
      <a href="${x.link.url}" style="display:inline-block;background:#dfb257;color:#221a05;font-family:Helvetica,Arial,sans-serif;font-size:14px;font-weight:bold;text-decoration:none;padding:13px 34px;border-radius:9px">${esc(x.link.label)}</a>
      <div style="font-family:Helvetica,Arial,sans-serif;font-size:10.5px;color:#5d7568;padding-top:10px;word-break:break-all">or copy this link: ${esc(x.link.url)}</div>
    </td></tr></table>`:'';
  const paras=String(body).split(/\n{2,}/).map(p=>
    `<p style="margin:0 0 14px;font-family:Helvetica,Arial,sans-serif;font-size:14px;line-height:1.7;color:#cfe0d5;white-space:pre-line">${p}</p>`).join('');
  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#080f0b">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#080f0b"><tr><td align="center" style="padding:28px 12px">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%">
      <tr><td>${logo}</td></tr>
      <tr><td style="background:#131e1a;border:1px solid #28382f;border-top:none;border-radius:0 0 12px 12px;padding:30px 34px">
        <div style="font-family:Georgia,serif;font-size:21px;color:#dfb257;padding-bottom:6px">${esc(title)}</div>
        <div style="border-bottom:1px solid #28382f;margin-bottom:18px"></div>
        <p style="margin:0 0 14px;font-family:Helvetica,Arial,sans-serif;font-size:14px;color:#cfe0d5">Hi <b>${esc(name)}</b>,</p>
        ${paras}${codeBox}${button}
      </td></tr>
      <tr><td style="padding:18px 10px;text-align:center">
        <div style="font-family:Helvetica,Arial,sans-serif;font-size:11px;color:#5d7568;line-height:1.6">
          ${esc(footer||'This is an automated message from your KARN game server.')}<br>
          Please do not reply directly to this email.</div>
      </td></tr>
    </table>
  </td></tr></table></body></html>`;
}
function sendUserMail(u,subject,title,body,footer,extras){
  const x=users[u];
  if(!x||!x.email||!misc.smtp||!misc.smtp.host)return;
  sendMail(x.email,subject,mailTemplate(title,u,body,footer,extras),mailHTML(title,u,body,footer,extras))
    .then(()=>{mailLog.unshift({to:maskEmail(x.email),subject,ok:true,ts:Date.now()});
      if(mailLog.length>25)mailLog.length=25;
      console.log('mail sent:',subject,'->',maskEmail(x.email));})
    .catch(e=>{mailLog.unshift({to:maskEmail(x.email),subject,ok:false,err:e.message,ts:Date.now()});
      if(mailLog.length>25)mailLog.length=25;
      console.error('mail failed:',subject,'->',u,':',e.message);});
}
function renameUser(old,neu){
  users[neu]=users[old];delete users[old];
  for(const u in users){const x=users[u];
    for(const k of['friends','reqIn','reqOut','blocked'])x[k]=x[k].map(n=>n===old?neu:n);
  }
  for(const t in sessions)if(sessions[t].user===old)sessions[t].user=neu;
  for(const id in saved){if(saved[id].host===old)saved[id].host=neu;if(saved[id].guest===old)saved[id].guest=neu;}
  for(const id in matches){if(matches[id].host===old)matches[id].host=neu;if(matches[id].guest===old)matches[id].guest=neu;}
  for(const e of queue)if(e.user===old)e.user=neu;
  for(const id in challenges){if(challenges[id].from===old)challenges[id].from=neu;if(challenges[id].to===old)challenges[id].to=neu;}
  for(const f of misc.feedback)if(f.from===old)f.from=neu;
  for(const c in misc.recov)if(misc.recov[c].user===old)misc.recov[c].user=neu;
  if(ADMIN_NAMES.includes(neu.toLowerCase()))users[neu].admin=true;
  saveU();saveM();saveS();
}

const sessions={};   /* token -> {user,exp} */
const matches={};    /* live matches        */
const challenges={}; /* pending challenges  */
const queue=[];      /* matchmaking queue: {user,elo,mode,ts,alive} */
let mseq=Date.now()%100000,cseq=1;

/* ---------- matchmaking ----------
   Pair players of similar Elo (within 150). After 10 seconds in the queue,
   pair with the closest-rated player available, however far apart.        */
function dequeue(u){const i=queue.findIndex(e=>e.user===u);if(i>-1)queue.splice(i,1);}
function createQueueMatch(a,b,mode){
  dequeue(a.user);dequeue(b.user);
  for(const e of[a,b]){const cur=activeMatchOf(e.user);if(cur&&cur.status==='open')delete matches[cur.id];}
  const white=Math.random()<0.5?a:b,black=white===a?b:a;
  const id=String(mseq++);
  matches[id]={id,host:white.user,guest:black.user,mode,status:'active',mid:randomMid(),
    events:[],result:null,started:Date.now(),last:Date.now()};
  console.log('matchmade',id,':',white.user,'('+white.elo+') vs',black.user,'('+black.elo+')','['+mode+']');
}
setInterval(function matchmake(){
  const now=Date.now();
  /* drop entries whose owner stopped polling (left/closed the page) */
  for(let i=queue.length-1;i>=0;i--)
    if(now-queue[i].alive>8000||!users[queue[i].user])queue.splice(i,1);
  for(const mode of['quick','setup']){
    let go=true;
    while(go){
      go=false;
      const q=queue.filter(e=>e.mode===mode);
      if(q.length<2)break;
      q.sort((a,b)=>a.ts-b.ts);           /* longest waiting first */
      const a=q[0],waited=now-a.ts;
      const cands=q.slice(1).filter(b=>!isBlocked(a.user,b.user));
      if(!cands.length)break;
      cands.sort((x,y)=>Math.abs(x.elo-a.elo)-Math.abs(y.elo-a.elo));
      const best=cands[0];
      if(Math.abs(best.elo-a.elo)<=150||waited>=10000){
        createQueueMatch(a,best,mode);
        go=true;
      }
    }
  }
},1000);
const SESS_TTL=7*24*3600e3;          /* sessions idle-expire after 7 days */

/* ---------- security: rate limiting ---------- */
const RATES={};
function rate(key,limit,win){
  const now=Date.now();
  let r=RATES[key];
  if(!r||now>r.reset)r=RATES[key]={n:0,reset:now+win};
  r.n++;
  return r.n<=limit;
}
setInterval(()=>{const now=Date.now();for(const k in RATES)if(RATES[k].reset<now)delete RATES[k];},60e3);
setInterval(()=>{ /* expire idle sessions, stale challenges + login links */
  const now=Date.now();
  for(const t in sessions)if(sessions[t].exp<now)delete sessions[t];
  for(const id in challenges)if(now-challenges[id].ts>5*60e3)delete challenges[id];
  for(const k in loginKeys)if(loginKeys[k].exp<now)delete loginKeys[k];
},60e3);

/* ---------- helpers ---------- */
function hashPass(pw,salt){salt=salt||crypto.randomBytes(12).toString('hex');
  return{salt,hash:crypto.scryptSync(pw,salt,32).toString('hex')};}
function newToken(){return crypto.randomBytes(24).toString('hex');}
function online(u){const now=Date.now();return Object.values(sessions).some(s=>s.user===u&&s.exp>now);}
function pub(u){const x=users[u];if(!x)return{user:u,elo:'?',deleted:true};
  return{user:u,elo:x.elo,wins:x.wins,losses:x.losses,draws:x.draws,games:x.games,
    created:x.created,private:x.private,online:online(u)};}
function addNotif(u,n){
  const x=users[u];if(!x)return;
  if(typeof n==='string')n={type:'info',text:n};
  x.notifs.unshift({id:nseq++,ts:Date.now(),read:false,type:n.type||'info',
    text:n.text,from:n.from||null,data:n.data||null});
  if(x.notifs.length>60)x.notifs.length=60;
  saveU();
}
function isBlocked(a,b){
  return(users[a]&&users[a].blocked.includes(b))||(users[b]&&users[b].blocked.includes(a));
}
function unfriend(a,b){
  for(const[p,q]of[[a,b],[b,a]]){
    const x=users[p];if(!x)continue;
    x.friends=x.friends.filter(n=>n!==q);
    x.reqIn=x.reqIn.filter(n=>n!==q);
    x.reqOut=x.reqOut.filter(n=>n!==q);
  }
}
function applyElo(aName,bName,scoreA){
  const A=users[aName],B=users[bName];
  const K=(misc.balance&&misc.balance.rules&&misc.balance.rules.eloK)||32;
  const Ea=1/(1+Math.pow(10,(B.elo-A.elo)/400));
  const dA=Math.round(K*(scoreA-Ea)),dB=-dA;
  A.elo+=dA;B.elo+=dB;A.games++;B.games++;
  if(scoreA===1){A.wins++;B.losses++;}
  else if(scoreA===0){A.losses++;B.wins++;}
  else{A.draws++;B.draws++;}
  saveU();
  return{[aName]:dA,[bName]:dB};
}
function randomMid(){
  const cols=[];
  while(cols.length<3){const c=Math.floor(Math.random()*8);if(!cols.includes(c))cols.push(c);}
  return{cols:cols.sort((a,b)=>a-b),flip:Math.random()<0.5};
}
function matchInfo(m,forUser){
  return{id:m.id,mode:m.mode,status:m.status,mid:m.mid,
    players:[pub(m.host),m.guest?pub(m.guest):null],
    you:forUser===m.host?0:forUser===m.guest?1:null,
    result:m.result||null,evCount:m.events.length};
}
function activeMatchOf(u){
  for(const id in matches){const m=matches[id];
    if((m.host===u||m.guest===u)&&m.status!=='done')return m;}
  return null;
}
function matchSummary(rec,viewer){
  return{id:rec.id,host:rec.host,guest:rec.guest,mode:rec.mode,
    winner:rec.result?rec.result.winner:null,resigned:rec.result?rec.result.resigned:null,
    ended:rec.ended,events:rec.events.length};
}
function finalizeMatch(m,winner,resignedSide){
  const score=winner==='draw'?0.5:(winner===0?1:0);
  const delta=applyElo(m.host,m.guest,score);
  m.result={winner,resigned:resignedSide??null,delta,
    elo:{[m.host]:users[m.host].elo,[m.guest]:users[m.guest].elo}};
  m.status='done';m.last=Date.now();
  /* save the record */
  saved[m.id]={id:m.id,host:m.host,guest:m.guest,mode:m.mode,mid:m.mid,
    events:m.events,result:{winner,resigned:resignedSide??null,delta},
    started:m.started,ended:Date.now()};
  for(const[u,side]of[[m.host,0],[m.guest,1]]){
    users[u].matches.unshift(m.id);
    if(users[u].matches.length>50)users[u].matches.length=50;
    const opp=side===0?m.guest:m.host,d=delta[u];
    addNotif(u,{type:'result',from:opp,data:{win:winner==='draw'?'draw':winner===side,matchId:m.id},
      text:winner==='draw'
        ?`Draw against ${opp} (${d>=0?'+':''}${d} Elo)`
        :winner===side
          ?`You defeated ${opp}${resignedSide!=null&&resignedSide!==side?' — they resigned':''} (+${d} Elo → ${users[u].elo})`
          :`You lost to ${opp}${resignedSide===side?' — you resigned':''} (${d} Elo → ${users[u].elo})`});
  }
  metrics.gamesFinished++;saveX();saveM();saveU();
  console.log('match',m.id,'result:',winner==='draw'?'draw':PNAMES[winner]);
}
setInterval(()=>{
  const now=Date.now();
  for(const id in matches){const m=matches[id];
    if(m.status==='open'&&now-m.last>10*60e3)delete matches[id];
    else if(m.status==='active'&&now-m.last>45*60e3)delete matches[id];
    else if(m.status==='done'&&now-m.last>15*60e3)delete matches[id];}
},60e3);

/* ---------- http plumbing ---------- */
const SEC_HEADERS={'X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY','Referrer-Policy':'no-referrer'};
function json(res,code,obj){
  res.writeHead(code,{'Content-Type':'application/json',
    'Access-Control-Allow-Origin':'*',
    'Access-Control-Allow-Headers':'Content-Type, X-Token',
    'Access-Control-Allow-Methods':'GET, POST, OPTIONS',...SEC_HEADERS});
  res.end(JSON.stringify(obj));
}
function bad(res,msg,code){json(res,code||400,{error:msg});}
function readBody(req){
  return new Promise((resolve,reject)=>{
    let b='';
    req.on('data',c=>{b+=c;if(b.length>1e6)req.destroy();});
    req.on('end',()=>{try{resolve(b?JSON.parse(b):{});}catch(e){reject(e);}});
    req.on('error',reject);
  });
}
function findUser(name){
  const k=String(name||'').trim().toLowerCase();
  return Object.keys(users).find(n=>n.toLowerCase()===k)||null;
}

const TRUST_PROXY=process.argv.includes('--trust-proxy');
const handler=async(req,res)=>{
try{
  const url=new URL(req.url,'http://x');
  const p=url.pathname;
  if(req.method==='OPTIONS')return json(res,200,{});
  const ip=(TRUST_PROXY&&String(req.headers['x-forwarded-for']||'').split(',')[0].trim())
    ||req.socket.remoteAddress||'?';
  if(!rate(ip+':api',150,5000))return bad(res,'Too many requests — slow down',429);
  if(req.headers.host)PUBLIC_BASE=(typeof IS_TLS!=='undefined'&&IS_TLS?'https':'http')+'://'+req.headers.host;
  if(req.method==='GET'&&p==='/logo.jpg'){
    try{
      if(!logoExists())throw 0;
      const img=fs.readFileSync(path.join(DIR,'karn-logo.jpg'));
      res.writeHead(200,{'Content-Type':'image/jpeg','Cache-Control':'public, max-age=3600',...SEC_HEADERS});
      return res.end(img);
    }catch(e){res.writeHead(404,SEC_HEADERS);return res.end('no logo');}
  }
  if(req.method==='GET'&&(p==='/'||p==='/karn.html')){
    let html;
    try{html=fs.readFileSync(GAME);}catch(e){return bad(res,'karn.html not found next to server.js',500);}
    res.writeHead(200,{'Content-Type':'text/html; charset=utf-8',...SEC_HEADERS,
      'Content-Security-Policy':"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'"});
    return res.end(html);
  }
  if(!p.startsWith('/api/')){res.writeHead(404,SEC_HEADERS);return res.end('not found');}
  const body=req.method==='POST'?await readBody(req):{};
  const token=req.headers['x-token']||'';
  let me=null;
  const sess=sessions[token];
  if(sess){
    if(sess.exp<Date.now())delete sessions[token];
    else{sess.exp=Date.now()+SESS_TTL;me=sess.user;}
  }

  /* ================= accounts ================= */
  if(p==='/api/register'&&req.method==='POST'){
    if(!rate(ip+':auth',25,5*60e3))return bad(res,'Too many attempts — try again in a few minutes',429);
    const u=String(body.user||'').trim(),pw=String(body.pass||'').slice(0,200);
    if(!/^[A-Za-z0-9_]{2,16}$/.test(u))return bad(res,'Username: 2-16 letters, numbers or _');
    if(pw.length<6)return bad(res,'Password must be at least 6 characters');
    if(findUser(u))return bad(res,'That username is taken');
    if(Object.keys(users).length>=2000)return bad(res,'Server is full');
    const dev=devOf(req);
    if(dev){
      const D=devTouch(dev);
      if(D.banned)return bad(res,'Account creation is blocked on this device. Contact Support if you believe this is a mistake.',403);
      const devLim=balRule('deviceLimit',DEV_LIMIT);
      if(D.users.filter(n=>users[n]).length>=devLim)return bad(res,'This device has reached the limit of '+devLim+' accounts',403);
    }
    const first=Object.keys(users).length===0||ADMIN_NAMES.includes(u.toLowerCase());
    const{salt,hash}=hashPass(pw);
    users[u]={salt,hash,elo:1000,wins:0,losses:0,draws:0,games:0,created:Date.now(),
      admin:first,staff:false,private:false,banned:null,flagged:null,email:null,
      emailPrefs:{friendReq:true},
      friends:[],reqIn:[],reqOut:[],blocked:[],notifs:[],matches:[]};
    if(first)addNotif(u,{type:'info',text:'You are the ADMIN of this server — the Admin page is in your side menu.'});
    metrics.registrations++;saveX();saveU();
    devTouch(dev,u);
    const t=newToken();sessions[t]={user:u,exp:Date.now()+SESS_TTL};
    console.log('new account:',u,first?'(ADMIN)':'');
    return json(res,200,{token:t,profile:pub(u)});
  }
  if(p==='/api/login'&&req.method==='POST'){
    if(!rate(ip+':auth',25,5*60e3))return bad(res,'Too many attempts — try again in a few minutes',429);
    const u=findUser(body.user);
    if(!u){crypto.scryptSync('x','00'.repeat(12),32);return bad(res,'Wrong username or password',401);}
    const lo=lockouts[u];
    if(lo&&lo.until>Date.now()){
      const mailed=maybeMailLoginLink(u,req);
      return bad(res,mailed
        ?'Account temporarily locked — we emailed you a one-time login link (also check spam). Or wait 10 minutes.'
        :'Account temporarily locked after failed attempts — wait 10 minutes or use Support',429);
    }
    const x=users[u];
    const h=crypto.scryptSync(String(body.pass||'').slice(0,200),x.salt,32).toString('hex');
    const ok=h.length===x.hash.length&&crypto.timingSafeEqual(Buffer.from(h),Buffer.from(x.hash));
    if(!ok){
      const l=lockouts[u]=lockouts[u]||{n:0,until:0};
      l.n++;
      if(l.n>=8){
        l.until=Date.now()+10*60e3;l.n=0;l.mailed=false;
        const mailed=maybeMailLoginLink(u,req);
        return bad(res,mailed
          ?'Too many attempts — the account is locked for 10 minutes. We emailed you a one-time login link.'
          :'Too many attempts — the account is locked for 10 minutes. Use Support if you forgot your password.',429);
      }
      return bad(res,'Wrong username or password',401);
    }
    delete lockouts[u];
    if(x.banned)return bad(res,'This account has been banned'+(x.banned.reason?': '+x.banned.reason:''),403);
    devTouch(devOf(req),u);   /* remember which devices this account uses */
    const t=newToken();sessions[t]={user:u,exp:Date.now()+SESS_TTL};
    metrics.logins++;saveX();
    return json(res,200,{token:t,profile:pub(u)});
  }
  /* ----- current game balance (public — clients apply it at boot) ----- */
  if(p==='/api/balance'&&req.method==='GET')
    return json(res,200,{balance:misc.balance,v:misc.balV});
  if(p==='/api/pages'&&req.method==='GET')
    return json(res,200,{pages:misc.pages,v:misc.balV});

  /* ----- one-time login link (from lockout email) ----- */
  if(p==='/api/loginkey'&&req.method==='POST'){
    if(!rate(ip+':auth',25,5*60e3))return bad(res,'Too many attempts',429);
    const e=loginKeys[String(body.key||'')];
    if(!e||e.exp<Date.now()||!users[e.user])return bad(res,'Invalid or expired login link');
    delete loginKeys[String(body.key)];
    if(users[e.user].banned)return bad(res,'This account has been banned',403);
    delete lockouts[e.user];                 /* the link clears the lock */
    const t=newToken();sessions[t]={user:e.user,exp:Date.now()+SESS_TTL};
    metrics.logins++;saveX();
    console.log('one-time login link used by',e.user);
    return json(res,200,{token:t,profile:pub(e.user)});
  }

  /* ----- support: opens a real ticket (no login; never reveals if an account exists) ----- */
  if(p==='/api/support/request'&&req.method==='POST'){
    if(!rate(ip+':auth',25,5*60e3))return bad(res,'Too many attempts',429);
    const t=findUser(body.user);
    if(!t)return json(res,200,{ok:1,emailed:false});
    const msg=String(body.message||'').trim().slice(0,1000)||'Account help requested (no details given).';
    /* reuse a recent open support ticket instead of spamming new ones */
    let tk=misc.tickets.find(x=>x.to===t&&x.from==='support'&&x.status==='open'&&Date.now()-x.ts<3600e3);
    if(tk){
      if(tk.messages.length<50)tk.messages.push({by:t,text:msg,ts:Date.now()});
    }else{
      tk={id:misc.fseq++,to:t,from:'support',subject:'Support request from '+t,
        ts:Date.now(),status:'open',priority:'low',notes:[],
        key:crypto.randomBytes(16).toString('hex'),
        messages:[{by:t,text:msg,ts:Date.now()}]};
      misc.tickets.unshift(tk);
      if(misc.tickets.length>200)misc.tickets.length=200;
    }
    if(!misc.support.some(s2=>s2.user===t&&!s2.done&&Date.now()-s2.ts<3600e3)){
      misc.support.unshift({id:misc.fseq++,user:t,ts:Date.now(),done:false});
      if(misc.support.length>100)misc.support.length=100;
    }
    saveS();
    notifyAdmins(`🛟 Support ticket #${tk.id} from ${t}: "${msg.slice(0,60)}${msg.length>60?'…':''}"`);
    const em=users[t].email;
    const willEmail=!!(em&&misc.smtp&&misc.smtp.host);
    if(willEmail)
      sendUserMail(t,`[KARN Support] Ticket #${tk.id} — we're on it`,
        `Ticket #${tk.id} opened`,
        `We received your support request and opened a ticket for you.\n\nYour message:\n"${msg.slice(0,400)}"\n\nOur automated assistant is looking at it right now — you'll usually get a reply within seconds. Use the button below to follow the conversation and respond. It works even if you're locked out or suspended, no login needed.`,
        'Reply "human" on the ticket at any time to reach a real staff member.',
        {link:{label:'Open your ticket',url:ticketLink(tk,req)}});
    /* the assistant triages it immediately */
    agentHandle(tk,msg,req);
    return json(res,200,{ok:1,emailed:willEmail,hint:willEmail?maskEmail(em):undefined,ticket:tk.id});
  }
  /* ----- guest ticket access via emailed link (no login) ----- */
  if(p==='/api/tickets/guest'&&req.method==='POST'){
    if(!rate(ip+':guest',60,5*60e3))return bad(res,'Too many attempts',429);
    const tk=misc.tickets.find(x=>x.key===String(body.key||''));
    if(!tk)return bad(res,'Invalid or expired ticket link',404);
    return json(res,200,{ticket:{...tk,notes:undefined}});
  }
  if(p==='/api/tickets/guest/reply'&&req.method==='POST'){
    if(!rate(ip+':guest',60,5*60e3))return bad(res,'Too many attempts',429);
    const tk=misc.tickets.find(x=>x.key===String(body.key||''));
    if(!tk)return bad(res,'Invalid or expired ticket link',404);
    if(tk.status!=='open')return bad(res,'This ticket is closed');
    const text=String(body.text||'').trim().slice(0,1000);
    if(text.length<2)return bad(res,'Write a message first');
    if(tk.messages.length>=50)return bad(res,'Ticket thread is full');
    tk.messages.push({by:tk.to,text,ts:Date.now()});
    saveS();
    if(users[tk.from])
      addNotif(tk.from,{type:'ticket',from:tk.to,data:{tid:tk.id},
        text:`${tk.to} replied to ticket #${tk.id} ("${tk.subject}")`});
    else if(tk.human||tk.from!=='support')
      notifyAdmins(`${tk.to} replied to ticket #${tk.id} ("${tk.subject}")`);
    agentHandle(tk,text,req);     /* the assistant follows up */
    return json(res,200,{ok:1,ticket:tk});
  }

  /* ----- account recovery (no login required; uses the auth rate bucket) ----- */
  if(p==='/api/recover/check'&&req.method==='POST'){
    if(!rate(ip+':auth',25,5*60e3))return bad(res,'Too many attempts',429);
    const rc=misc.recov[String(body.code||'').trim().toUpperCase()];
    if(!rc||rc.exp<Date.now()||!users[rc.user])return bad(res,'Invalid or expired recovery code');
    return json(res,200,{user:rc.user});
  }
  if(p==='/api/recover/complete'&&req.method==='POST'){
    if(!rate(ip+':auth',25,5*60e3))return bad(res,'Too many attempts',429);
    const codeK=String(body.code||'').trim().toUpperCase();
    const rc=misc.recov[codeK];
    if(!rc||rc.exp<Date.now()||!users[rc.user])return bad(res,'Invalid or expired recovery code');
    const pw=String(body.pass||'').slice(0,200);
    if(pw.length<6)return bad(res,'Password must be at least 6 characters');
    let uname=rc.user;
    const nn=String(body.newUser||'').trim();
    if(nn&&nn!==rc.user){
      if(!/^[A-Za-z0-9_]{2,16}$/.test(nn))return bad(res,'Username: 2-16 letters, numbers or _');
      if(findUser(nn))return bad(res,'That username is taken');
      renameUser(rc.user,nn);uname=nn;
    }
    const{salt,hash}=hashPass(pw);
    users[uname].salt=salt;users[uname].hash=hash;
    delete misc.recov[codeK];
    saveU();saveS();
    notifyAdmins(`Account recovery completed for ${uname}`);
    const t=newToken();sessions[t]={user:uname,exp:Date.now()+SESS_TTL};
    console.log('account recovered:',uname);
    return json(res,200,{token:t,profile:pub(uname)});
  }
  if(!me||!users[me])return bad(res,'Not logged in',401);
  const M=users[me];
  if(M.banned){delete sessions[token];return bad(res,'This account has been banned',403);}
  const STAFF=M.admin||M.staff;
  if(p==='/api/logout'){delete sessions[token];delete vaultKeys[token];dequeue(me);return json(res,200,{ok:1});}
  if(p==='/api/me')return json(res,200,{profile:pub(me)});
  if(p==='/api/profile'&&req.method==='POST'){
    if(typeof body.private==='boolean'){M.private=body.private;saveU();}
    if(body.email!==undefined){
      const em=String(body.email||'').trim().slice(0,254);
      if(em&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em))return bad(res,'That does not look like an email address');
      M.email=em||null;saveU();
    }
    if(typeof body.emailFriendReq==='boolean'){M.emailPrefs.friendReq=body.emailFriendReq;saveU();}
    if(body.theme!==undefined){
      if(THEME_LIST.includes(String(body.theme)))M.theme=String(body.theme);
      saveU();
    }
    return json(res,200,{ok:1,private:M.private,email:M.email||'',emailPrefs:M.emailPrefs});
  }

  /* ================= lobby ================= */
  if(p==='/api/lobby'){
    /* privacy: only the TOP 10 are visible — nobody can scout the full player list */
    const players=Object.keys(users).filter(u=>!users[u].banned).map(pub).sort((a,b)=>b.elo-a.elo).slice(0,10);
    const open=Object.values(matches).filter(m=>m.status==='open'&&!isBlocked(m.host,me))
      .map(m=>({id:m.id,host:m.host,hostElo:users[m.host].elo,mode:m.mode}));
    const mine=activeMatchOf(me);
    const qe=queue.find(e=>e.user===me);
    if(qe)qe.alive=Date.now();          /* heartbeat while queued */
    return json(res,200,{players,open,match:mine?matchInfo(mine,me):null,
      queue:{waiting:qe?Date.now()-qe.ts:null,mode:qe?qe.mode:null,size:queue.length},
      me:{...pub(me),admin:M.admin,staff:M.staff,dev:!!M.dev,rank:rankOf(M),manager:M.manager||null,privateFlag:M.private,email:M.email||'',
        emailFriendReq:M.emailPrefs.friendReq!==false,theme:M.theme||'default',
        unread:M.notifs.filter(n=>!n.read).length,reqIn:M.reqIn.length,balV:misc.balV,
        latest:M.notifs.slice(0,6),
        chIn:Object.values(challenges).filter(c=>c.to===me).map(c=>c.id)}});
  }
  /* ----- matchmaking queue ----- */
  if(p==='/api/queue'&&req.method==='POST'){
    const cur=activeMatchOf(me);
    if(cur&&cur.status==='active')return bad(res,'You are already in a match');
    if(cur)delete matches[cur.id];
    dequeue(me);
    queue.push({user:me,elo:users[me].elo,mode:body.mode==='setup'?'setup':'quick',
      ts:Date.now(),alive:Date.now()});
    return json(res,200,{ok:1});
  }
  if(p==='/api/queue/cancel'&&req.method==='POST'){dequeue(me);return json(res,200,{ok:1});}
  /* ----- challenges ----- */
  if(p==='/api/challenge'&&req.method==='POST'){
    const t=findUser(body.user);
    if(!t||t===me)return bad(res,'No such player');
    if(!online(t))return bad(res,'That player is offline');
    if(isBlocked(me,t))return bad(res,'Cannot challenge this player');
    if(Object.values(challenges).some(c=>c.from===me&&c.to===t))return bad(res,'Challenge already pending');
    if(Object.values(challenges).filter(c=>c.from===me).length>=5)return bad(res,'Too many pending challenges');
    const id='c'+(cseq++);
    const mode=body.mode==='setup'?'setup':'quick';
    challenges[id]={id,from:me,to:t,mode,ts:Date.now()};
    addNotif(t,{type:'challenge',from:me,data:{cid:id,mode},
      text:`${me} (${users[me].elo}) challenged you to a ${mode==='setup'?'full-setup':'quick'} match`});
    return json(res,200,{ok:1,cid:id});
  }
  if(p==='/api/challenge/accept'&&req.method==='POST'){
    const c=challenges[String(body.cid)];
    if(!c||c.to!==me)return bad(res,'Challenge expired');
    if(!users[c.from])return bad(res,'Challenger is gone');
    const myCur=activeMatchOf(me),theirCur=activeMatchOf(c.from);
    if(myCur&&myCur.status==='active')return bad(res,'You are already in a match');
    if(theirCur&&theirCur.status==='active')return bad(res,'Challenger is busy in another match');
    if(myCur)delete matches[myCur.id];
    if(theirCur)delete matches[theirCur.id];
    dequeue(me);dequeue(c.from);
    delete challenges[c.id];
    const id=String(mseq++);
    matches[id]={id,host:c.from,guest:me,mode:c.mode,status:'active',mid:randomMid(),
      events:[],result:null,started:Date.now(),last:Date.now()};
    addNotif(c.from,{type:'info',text:`${me} accepted your challenge — to battle!`});
    console.log('challenge match',id,':',c.from,'vs',me);
    return json(res,200,matchInfo(matches[id],me));
  }
  if(p==='/api/challenge/decline'&&req.method==='POST'){
    const c=challenges[String(body.cid)];
    if(c&&c.to===me){
      delete challenges[c.id];
      addNotif(c.from,{type:'info',text:`${me} declined your challenge`});
    }
    return json(res,200,{ok:1});
  }
  if(p==='/api/host'&&req.method==='POST'){
    const cur=activeMatchOf(me);
    if(cur&&cur.status==='active')return bad(res,'You are already in a match');
    if(cur)delete matches[cur.id];
    const id=String(mseq++);
    matches[id]={id,host:me,guest:null,mode:body.mode==='setup'?'setup':'quick',
      status:'open',mid:randomMid(),events:[],result:null,started:Date.now(),last:Date.now()};
    return json(res,200,{id});
  }
  if(p==='/api/host/cancel'&&req.method==='POST'){
    const cur=activeMatchOf(me);
    if(cur&&cur.status==='open')delete matches[cur.id];
    return json(res,200,{ok:1});
  }
  if(p==='/api/join'&&req.method==='POST'){
    const m=matches[String(body.id)];
    if(!m||m.status!=='open')return bad(res,'Match no longer available');
    if(m.host===me)return bad(res,'You cannot join your own match');
    if(isBlocked(m.host,me))return bad(res,'Match no longer available');
    const cur=activeMatchOf(me);
    if(cur&&cur.status==='active')return bad(res,'You are already in a match');
    m.guest=me;m.status='active';m.started=Date.now();m.last=Date.now();
    console.log('match',m.id,':',m.host,'vs',m.guest,'('+m.mode+')');
    return json(res,200,matchInfo(m,me));
  }

  /* ================= notifications ================= */
  if(p==='/api/notifs'&&req.method==='GET')
    return json(res,200,{notifs:M.notifs,reqIn:M.reqIn,
      chIn:Object.values(challenges).filter(c=>c.to===me).map(c=>c.id)});
  if(p==='/api/notifs/read'&&req.method==='POST'){
    M.notifs.forEach(n=>n.read=true);saveU();
    return json(res,200,{ok:1});
  }

  /* ================= friends & blocking ================= */
  if(p==='/api/friends'&&req.method==='GET'){
    return json(res,200,{
      friends:M.friends.filter(u=>users[u]).map(pub),
      reqIn:M.reqIn.filter(u=>users[u]),
      reqOut:M.reqOut.filter(u=>users[u]),
      blocked:M.blocked.filter(u=>users[u])});
  }
  if(p==='/api/friends/request'&&req.method==='POST'){
    const t=findUser(body.user);
    if(!t)return bad(res,'No such player');
    if(t===me)return bad(res,"That's you, commander");
    if(M.friends.includes(t))return bad(res,'Already friends');
    if(M.blocked.includes(t))return bad(res,'You have blocked this player');
    if(isBlocked(me,t))return bad(res,'Cannot send a request to this player');
    if(M.reqOut.includes(t))return bad(res,'Request already sent');
    if(M.reqIn.includes(t)){ /* they already asked us — instant friendship */
      unfriend(me,t);
      M.friends.push(t);users[t].friends.push(me);
      addNotif(t,{type:'friendok',from:me,text:`${me} accepted your friend request`});
      saveU();return json(res,200,{ok:1,accepted:true});
    }
    M.reqOut.push(t);users[t].reqIn.push(me);
    addNotif(t,{type:'friendreq',from:me,text:`${me} sent you a friend request`});
    if(users[t].emailPrefs.friendReq!==false)
      sendUserMail(t,`[KARN] ${me} sent you a friend request`,'New friend request',
        `${me} (Elo ${users[me].elo}) wants to be your friend on KARN.\n\n`+
        `Log in and open your Notifications to accept or decline.`,
        'You can turn off friend-request emails on your Profile page.');
    saveU();return json(res,200,{ok:1});
  }
  if(p==='/api/friends/accept'&&req.method==='POST'){
    const t=findUser(body.user);
    if(!t||!M.reqIn.includes(t))return bad(res,'No request from that player');
    unfriend(me,t);
    M.friends.push(t);users[t].friends.push(me);
    addNotif(t,{type:'friendok',from:me,text:`${me} accepted your friend request`});
    saveU();return json(res,200,{ok:1});
  }
  if(p==='/api/friends/decline'&&req.method==='POST'){
    const t=findUser(body.user);
    if(t){M.reqIn=M.reqIn.filter(n=>n!==t);if(users[t])users[t].reqOut=users[t].reqOut.filter(n=>n!==me);saveU();}
    return json(res,200,{ok:1});
  }
  if(p==='/api/friends/remove'&&req.method==='POST'){
    const t=findUser(body.user);
    if(t){unfriend(me,t);saveU();}
    return json(res,200,{ok:1});
  }
  if(p==='/api/friends/block'&&req.method==='POST'){
    const t=findUser(body.user);
    if(!t||t===me)return bad(res,'No such player');
    unfriend(me,t);
    if(!M.blocked.includes(t))M.blocked.push(t);
    saveU();return json(res,200,{ok:1});
  }
  if(p==='/api/friends/unblock'&&req.method==='POST'){
    const t=findUser(body.user);
    if(t){M.blocked=M.blocked.filter(n=>n!==t);saveU();}
    return json(res,200,{ok:1});
  }

  /* ================= feedback (any user) ================= */
  if(p==='/api/feedback'&&req.method==='POST'){
    const text=String(body.text||'').trim().slice(0,1000);
    if(text.length<3)return bad(res,'Feedback is empty');
    misc.feedback.unshift({id:misc.fseq++,from:me,text,ts:Date.now()});
    if(misc.feedback.length>200)misc.feedback.length=200;
    saveS();
    notifyAdmins(`📬 New feedback from ${me}: "${text.slice(0,60)}${text.length>60?'…':''}"`);
    return json(res,200,{ok:1});
  }

  /* ================= staff tools ================= */
  if(p.startsWith('/api/staff/')){
    if(!STAFF)return bad(res,'Staff only',403);
    const myRank=rankOf(M);
    const notifyRank=(min,n,except)=>{for(const u2 in users)if(u2!==me&&u2!==except&&rankOf(users[u2])>=min)addNotif(u2,n);};

    /* ---------- team roster & chain of command ---------- */
    if(p==='/api/staff/team'&&req.method==='GET'){
      const team=Object.keys(users).filter(u2=>rankOf(users[u2])>0)
        .map(u2=>({user:u2,rank:rankOf(users[u2]),rankName:RANK_NAMES[rankOf(users[u2])],
          manager:users[u2].manager||null,elo:users[u2].elo,dev:!!users[u2].dev,
          reports:Object.keys(users).filter(r2=>users[r2].manager===u2&&rankOf(users[r2])>0).length}))
        .sort((a,b)=>b.rank-a.rank||a.user.localeCompare(b.user));
      return json(res,200,{team,myRank,rankNames:RANK_NAMES});
    }
    if(p==='/api/staff/setrank'&&req.method==='POST'){
      const t2=findUser(body.user);
      if(!t2)return bad(res,'No such player');
      if(users[t2].admin)return bad(res,'The admin outranks everyone');
      const cur=rankOf(users[t2]),want=Math.max(0,Math.min(4,+body.rank||0));
      /* chain of command: you may only manage people BELOW you, and only
         move them within the ranks below you */
      if(!M.admin){
        if(myRank<3)return bad(res,'Only Team Leads and above can change ranks',403);
        if(cur>=myRank)return bad(res,'You cannot change the rank of someone at or above your own rank',403);
        if(want>=myRank)return bad(res,'You cannot promote someone to your own rank or higher',403);
      }
      users[t2].rank=want;users[t2].staff=want>0;
      if(want===0)users[t2].manager=null;
      saveU();
      const dir=want>cur?'promoted':want<cur?'demoted':'confirmed';
      addNotif(t2,{type:'info',text:want>0
        ?`${dir==='promoted'?'🎖 You have been PROMOTED':dir==='demoted'?'📉 You have been moved':'🧰 Your role was confirmed'} to ${RANK_NAMES[want]} by ${me}`
        :`Your staff role was removed by ${me}`});
      if(users[t2].email&&want!==cur)
        sendUserMail(t2,`[KARN Staff] Role change: ${RANK_NAMES[want]||'Player'}`,
          dir==='promoted'?'Congratulations!':'Role update',
          `${me} has ${dir} you ${want>0?'to '+RANK_NAMES[want]:'out of the staff team'}.${want>cur?'\n\nKeep it up — the team noticed your work.':''}`,null);
      notifyRank(3,{type:'info',text:`🧰 ${me} ${dir} ${t2} ${want>0?'to '+RANK_NAMES[want]:'(removed from staff)'}`},t2);
      return json(res,200,{ok:1,rank:want});
    }
    if(p==='/api/staff/setmanager'&&req.method==='POST'){
      const t2=findUser(body.user),mg=body.manager?findUser(body.manager):null;
      if(!t2)return bad(res,'No such player');
      if(body.manager&&!mg)return bad(res,'No such manager');
      if(!M.admin&&myRank<3)return bad(res,'Only Team Leads and above can assign reports',403);
      if(!M.admin&&rankOf(users[t2])>=myRank)return bad(res,'They are at or above your rank',403);
      if(mg&&rankOf(users[mg])<=rankOf(users[t2]))return bad(res,'A manager must outrank their report');
      if(mg===t2)return bad(res,'Nobody reports to themselves');
      users[t2].manager=mg;saveU();
      if(mg)addNotif(t2,{type:'info',text:`🧭 You now report to ${mg} (${RANK_NAMES[rankOf(users[mg])]})`});
      if(mg)addNotif(mg,{type:'info',text:`🧭 ${t2} (${RANK_NAMES[rankOf(users[t2])]}) now reports to you`});
      return json(res,200,{ok:1});
    }

    /* ---------- team room: meetings with agenda, votes & recorded decisions ---------- */
    if(p==='/api/staff/meetings'&&req.method==='GET'){
      return json(res,200,{meetings:misc.meetings.filter(mt=>myRank>=mt.minRank)
        .map(mt=>({id:mt.id,title:mt.title,by:mt.by,ts:mt.ts,status:mt.status,minRank:mt.minRank,
          msgs:mt.messages.length,open:mt.agenda.filter(a=>a.status==='open').length,
          decided:mt.agenda.filter(a=>a.status==='decided').length})),myRank});
    }
    if(p==='/api/staff/meeting/create'&&req.method==='POST'){
      if(misc.meetings.filter(mt=>mt.status==='open').length>=20)return bad(res,'Too many open meetings');
      const minRank=Math.max(1,Math.min(Math.min(4,myRank),+body.minRank||1));
      const mt={id:misc.fseq++,title:String(body.title||'Team meeting').slice(0,80),by:me,
        ts:Date.now(),status:'open',minRank,messages:[],agenda:[]};
      misc.meetings.unshift(mt);
      if(misc.meetings.length>100)misc.meetings.length=100;
      saveS();
      notifyRank(minRank,{type:'info',text:`🏛 ${me} opened a team meeting: "${mt.title}"${minRank>1?' ('+RANK_NAMES[minRank]+'+ only)':''}`});
      return json(res,200,{ok:1,id:mt.id});
    }
    {
      const mt=misc.meetings.find(x=>x.id===+((body&&body.id)||url.searchParams.get('id')));
      const inMt=mt&&myRank>=mt.minRank;
      if(p==='/api/staff/meeting'&&req.method==='GET'){
        if(!inMt)return bad(res,'Meeting not found',404);
        return json(res,200,{meeting:mt,myRank,rankNames:RANK_NAMES});
      }
      if(p==='/api/staff/meeting/msg'&&req.method==='POST'){
        if(!inMt)return bad(res,'Meeting not found',404);
        if(mt.status!=='open')return bad(res,'This meeting is closed');
        const text=String(body.text||'').trim().slice(0,600);
        if(text.length<1)return bad(res,'Write a message first');
        if(mt.messages.length>=400)return bad(res,'Meeting log is full');
        mt.messages.push({by:me,rank:myRank,text,ts:Date.now()});saveS();
        return json(res,200,{ok:1,meeting:mt});
      }
      if(p==='/api/staff/meeting/agenda'&&req.method==='POST'){
        if(!inMt)return bad(res,'Meeting not found',404);
        if(mt.status!=='open')return bad(res,'This meeting is closed');
        if(mt.agenda.length>=30)return bad(res,'Agenda is full');
        const a={id:misc.fseq++,text:String(body.text||'').trim().slice(0,300),by:me,status:'open',votes:{},decision:''};
        if(!a.text)return bad(res,'Write the agenda item first');
        mt.agenda.push(a);saveS();
        return json(res,200,{ok:1,meeting:mt});
      }
      if(p==='/api/staff/meeting/vote'&&req.method==='POST'){
        if(!inMt)return bad(res,'Meeting not found',404);
        const a=mt.agenda.find(x=>x.id===+body.aid);
        if(!a||a.status!=='open')return bad(res,'Item not open for voting');
        a.votes[me]=+body.v>0?1:-1;saveS();
        return json(res,200,{ok:1,meeting:mt});
      }
      if(p==='/api/staff/meeting/decide'&&req.method==='POST'){
        if(!inMt)return bad(res,'Meeting not found',404);
        const a=mt.agenda.find(x=>x.id===+body.aid);
        if(!a)return bad(res,'No such agenda item');
        /* decisions are recorded by the chair (creator) or any Team Lead+ */
        if(me!==mt.by&&myRank<3)return bad(res,'Only the meeting chair or a Team Lead+ records decisions',403);
        a.status='decided';a.decision=String(body.decision||'').slice(0,300)||'Approved';
        a.decidedBy=me;a.decidedTs=Date.now();saveS();
        notifyRank(mt.minRank,{type:'info',text:`✅ Decision in "${mt.title}": ${a.text.slice(0,60)} → ${a.decision.slice(0,60)}`},me);
        return json(res,200,{ok:1,meeting:mt});
      }
      if(p==='/api/staff/meeting/close'&&req.method==='POST'){
        if(!inMt)return bad(res,'Meeting not found',404);
        if(me!==mt.by&&myRank<3&&!M.admin)return bad(res,'Only the chair or a Team Lead+ closes meetings',403);
        mt.status='closed';mt.closedBy=me;mt.closedTs=Date.now();saveS();
        const dec=mt.agenda.filter(a=>a.status==='decided');
        notifyRank(mt.minRank,{type:'info',text:`🏛 Meeting "${mt.title}" closed — ${dec.length} decision(s) recorded`},me);
        return json(res,200,{ok:1});
      }
    }

    /* ---------- 1-on-1 management channels ---------- */
    if(p==='/api/staff/dms'&&req.method==='GET'){
      return json(res,200,{dms:misc.dms.filter(d=>d.a===me||d.b===me)
        .map(d=>({id:d.id,a:d.a,b:d.b,msgs:d.messages.length,
          last:d.messages.length?d.messages[d.messages.length-1].ts:d.ts}))});
    }
    if(p==='/api/staff/dm/open'&&req.method==='POST'){
      const t2=findUser(body.user);
      if(!t2||rankOf(users[t2])<1)return bad(res,'No such staff member');
      if(t2===me)return bad(res,'That would be a very quiet conversation');
      /* the senior party is always "a" — that side gets the management actions */
      const hi=rankOf(users[t2])>myRank?t2:me,lo=hi===me?t2:me;
      let d=misc.dms.find(x=>x.a===hi&&x.b===lo);
      if(!d){
        d={id:misc.fseq++,a:hi,b:lo,ts:Date.now(),messages:[]};
        misc.dms.unshift(d);
        if(misc.dms.length>200)misc.dms.length=200;
        saveS();
        addNotif(t2,{type:'info',text:`🗨 ${me} opened a 1-on-1 channel with you`});
      }
      return json(res,200,{ok:1,id:d.id});
    }
    {
      const d=misc.dms.find(x=>x.id===+((body&&body.id)||url.searchParams.get('id')));
      const inDm=d&&(d.a===me||d.b===me||M.admin);
      if(p==='/api/staff/dm'&&req.method==='GET'){
        if(!inDm)return bad(res,'Channel not found',404);
        return json(res,200,{dm:d,other:d.a===me?d.b:d.a,
          otherRank:rankOf(users[d.a===me?d.b:d.a]||{}),myRank,rankNames:RANK_NAMES});
      }
      if(p==='/api/staff/dm/msg'&&req.method==='POST'){
        if(!inDm)return bad(res,'Channel not found',404);
        const text=String(body.text||'').trim().slice(0,600);
        if(text.length<1)return bad(res,'Write a message first');
        if(d.messages.length>=300)d.messages.shift();
        d.messages.push({by:me,text,ts:Date.now()});saveS();
        const other=d.a===me?d.b:d.a;
        if(users[other])addNotif(other,{type:'info',text:`🗨 ${me} in your 1-on-1: "${text.slice(0,60)}${text.length>60?'…':''}"`});
        return json(res,200,{ok:1,dm:d});
      }
    }
    const t=findUser(body.user);
    if(p==='/api/staff/recovery'&&req.method==='POST'){
      if(!t)return bad(res,'No such player');
      if(users[t].admin&&!M.admin)return bad(res,'Staff cannot reset an admin account');
      const code=crypto.randomBytes(4).toString('hex').toUpperCase();
      misc.recov[code]={user:t,by:me,exp:Date.now()+30*60e3};
      saveS();
      notifyAdmins(`🔑 ${me} created a recovery code for ${t}`);
      console.log('recovery code for',t,'created by',me);
      return json(res,200,{code,user:t,expMins:30});
    }
    if(p==='/api/staff/setPass'&&req.method==='POST'){
      if(!t)return bad(res,'No such player');
      if((users[t].admin||users[t].staff)&&!M.admin)return bad(res,'Staff cannot change staff or admin passwords');
      if(String(body.pass||'').length<6)return bad(res,'Password must be at least 6 characters');
      const{salt,hash}=hashPass(String(body.pass).slice(0,200));
      users[t].salt=salt;users[t].hash=hash;
      addNotif(t,{type:'info',text:'Your password was changed by a staff member'});
      saveU();
      return json(res,200,{ok:1});
    }
    if(p==='/api/staff/tag'&&req.method==='POST'){
      if(!t)return bad(res,'No such player');
      users[t].flagged={by:me,note:String(body.note||'').slice(0,200),ts:Date.now()};
      saveU();
      notifyAdmins(`🏷 ${me} tagged ${t} for review${body.note?' — "'+String(body.note).slice(0,80)+'"':''}`);
      return json(res,200,{ok:1});
    }
    /* ---- ticket system ---- */
    if(p==='/api/staff/ticket'&&req.method==='POST'){
      if(!t)return bad(res,'No such player');
      const subject=String(body.subject||'').trim().slice(0,120);
      const msg=String(body.message||'').trim().slice(0,2000);
      if(!subject||msg.length<3)return bad(res,'A ticket needs a subject and a message');
      const tk={id:misc.fseq++,to:t,from:me,subject,body:msg,ts:Date.now(),status:'open',
        priority:'normal',notes:[],
        key:crypto.randomBytes(16).toString('hex'),
        messages:[{by:me,text:msg,ts:Date.now()}]};
      misc.tickets.unshift(tk);
      if(misc.tickets.length>200)misc.tickets.length=200;
      saveS();
      addNotif(t,{type:'ticket',from:me,data:{tid:tk.id},
        text:`Ticket #${tk.id} — ${subject}`});
      sendUserMail(t,`[KARN Support] Ticket #${tk.id} — ${subject}`,
        `Support ticket #${tk.id}`,
        `A member of the KARN staff team has opened a ticket regarding your account.\n\n`+
        `  Subject:  ${subject}\n`+
        `  Opened:   ${new Date(tk.ts).toUTCString()}\n`+
        `  Handled by: ${me}${M.admin?' (Administrator)':' (Staff)'}\n\n`+
        `Message:\n\n${msg.split('\n').map(l=>'  '+l).join('\n')}\n\n`+
        `Read the conversation and reply here — no login needed:\n\n    ${ticketLink(tk,req)}\n\n`+
        `You can also open it from your KARN notifications.`,
        'Questions? Use the Feedback button in the game — it goes straight to the admin.');
      console.log('ticket #'+tk.id,'to',t,'from',me);
      return json(res,200,{ok:1,id:tk.id});
    }
    if(p==='/api/staff/tickets'&&req.method==='GET')
      return json(res,200,{tickets:misc.tickets.slice(0,15)});
    if(p==='/api/staff/ticket/close'&&req.method==='POST'){
      const tk=misc.tickets.find(x=>x.id===+body.id);
      if(tk&&tk.status!=='closed'){
        tk.status='closed';tk.closedBy=me;saveS();
        addNotif(tk.to,{type:'ticket',from:me,data:{tid:tk.id},
          text:`Ticket #${tk.id} ("${tk.subject}") was closed by ${me}`});
      }
      return json(res,200,{ok:1});
    }
    if(p==='/api/staff/ticket/priority'&&req.method==='POST'){
      const tk=misc.tickets.find(x=>x.id===+body.id);
      const pr=String(body.p||'');
      if(tk&&['low','normal','high','urgent'].includes(pr)){tk.priority=pr;saveS();}
      return json(res,200,{ok:1});
    }
    if(p==='/api/staff/ticket/reopen'&&req.method==='POST'){
      const tk=misc.tickets.find(x=>x.id===+body.id);
      if(tk&&tk.status==='closed'){
        tk.status='open';saveS();
        addNotif(tk.to,{type:'ticket',from:me,data:{tid:tk.id},
          text:`Ticket #${tk.id} ("${tk.subject}") was reopened by ${me}`});
      }
      return json(res,200,{ok:1});
    }
    return bad(res,'Unknown staff endpoint',404);
  }
  /* users can read tickets addressed to them (staff can read any) */
  if(p==='/api/ticket'&&req.method==='GET'){
    const tk=misc.tickets.find(x=>x.id===+url.searchParams.get('id'));
    if(!tk)return bad(res,'Ticket not found',404);
    if(tk.to!==me&&tk.from!==me&&!STAFF)return bad(res,'Not your ticket',403);
    return json(res,200,{ticket:STAFF?tk:{...tk,notes:undefined},canReply:tk.status==='open',isStaff:STAFF});
  }
  /* both sides of a ticket can carry the conversation forward */
  if(p==='/api/ticket/reply'&&req.method==='POST'){
    const tk=misc.tickets.find(x=>x.id===+body.id);
    if(!tk)return bad(res,'Ticket not found',404);
    if(tk.to!==me&&tk.from!==me&&!STAFF)return bad(res,'Not your ticket',403);
    if(tk.status!=='open')return bad(res,'This ticket is closed — a staff member can reopen it');
    const text=String(body.text||'').trim().slice(0,1000);
    if(text.length<2)return bad(res,'Write a message first');
    if(!tk.messages)tk.messages=[{by:tk.from,text:tk.body||'',ts:tk.ts}]; /* safety migration */
    if(tk.messages.length>=50)return bad(res,'Ticket thread is full');
    tk.messages.push({by:me,text,ts:Date.now()});
    if(STAFF&&me!==tk.to&&tk.from==='support')tk.human=true;  /* a person took over — bot steps aside */
    saveS();
    if(me===tk.to){
      agentHandle(tk,text,req);   /* assistant follows up on the user's reply */
      /* player replied -> tell the staff member (or admins if they're gone) */
      if(users[tk.from])
        addNotif(tk.from,{type:'ticket',from:me,data:{tid:tk.id},
          text:`${me} replied to ticket #${tk.id} ("${tk.subject}")`});
      else notifyAdmins(`${me} replied to ticket #${tk.id} ("${tk.subject}")`);
    }else{
      /* staff replied -> tell (and email) the player */
      addNotif(tk.to,{type:'ticket',from:me,data:{tid:tk.id},
        text:`${me} replied to ticket #${tk.id} ("${tk.subject}")`});
      sendUserMail(tk.to,`[KARN Support] Re: Ticket #${tk.id} — ${tk.subject}`,
        `New reply on ticket #${tk.id}`,
        `${me} has replied to your support ticket.\n\n`+
        `  Ticket:   #${tk.id} — ${tk.subject}\n`+
        `  Replied:  ${new Date().toUTCString()}\n\n`+
        `Message:\n\n${text.split('\n').map(l=>'  '+l).join('\n')}\n\n`+
        `Read the conversation and reply here — no login needed:\n\n    ${ticketLink(tk,req)}\n\n`+
        `Or open it from your KARN notifications.`,
        'You can reply from the ticket in the game or via the link above.');
    }
    return json(res,200,{ok:1,ticket:tk});
  }

  /* ================= profiles & match records ================= */
  if(p==='/api/user'&&req.method==='GET'){
    const t=findUser(url.searchParams.get('name'));
    if(!t)return bad(res,'No such player',404);
    const X=users[t];
    const allowed=t===me||M.admin||!X.private;
    return json(res,200,{profile:pub(t),
      isFriend:M.friends.includes(t),reqOut:M.reqOut.includes(t),reqIn:M.reqIn.includes(t),
      iBlocked:M.blocked.includes(t),
      matches:allowed?X.matches.filter(id=>saved[id]).map(id=>matchSummary(saved[id],me)):null});
  }
  if(p==='/api/matchrec'&&req.method==='GET'){
    const rec=saved[String(url.searchParams.get('id'))];
    if(!rec)return bad(res,'Match not found',404);
    const involved=rec.host===me||rec.guest===me;
    const anyPublic=(users[rec.host]&&!users[rec.host].private)||(users[rec.guest]&&!users[rec.guest].private);
    if(!involved&&!M.admin&&!anyPublic)return bad(res,'This match is private',403);
    return json(res,200,{rec});
  }

  /* ================= dev containers ================= */
  /* Developers build page/card changes in private "dev containers".
     Nobody else sees them — not players, not staff. The admin can open any
     container to preview it and, if happy, publish it to the live site. */
  if(p.startsWith('/api/dev/')){
    const DEV=M.dev||M.admin;
    if(!DEV)return bad(res,'Developer accounts only',403);
    const mine=c=>c.owner===me||M.admin;
    if(p==='/api/dev/containers'&&req.method==='GET'){
      return json(res,200,{containers:misc.containers.filter(mine)
        .map(c=>({id:c.id,name:c.name,owner:c.owner,ts:c.ts,updated:c.updated,status:c.status||'draft',
          cards:(c.pages.custom||[]).reduce((n,t)=>n+t.blocks.length,0)+
                Object.values(c.pages.extends||{}).reduce((n,l)=>n+l.length,0),
          tabs:(c.pages.custom||[]).length})),isAdmin:!!M.admin});
    }
    if(p==='/api/dev/container/create'&&req.method==='POST'){
      if(misc.containers.filter(c=>c.owner===me).length>=10)return bad(res,'Container limit reached (10)');
      const c={id:misc.fseq++,name:String(body.name||'untitled').slice(0,40),owner:me,
        ts:Date.now(),updated:Date.now(),
        pages:JSON.parse(JSON.stringify(misc.pages))};   /* fork of the live site */
      misc.containers.push(c);saveS();
      return json(res,200,{ok:1,id:c.id});
    }
    {
      const c=misc.containers.find(x=>x.id===+((body&&body.id)||url.searchParams.get('id')));
      if(p==='/api/dev/container'&&req.method==='GET'){
        if(!c||!mine(c))return bad(res,'Container not found',404);
        return json(res,200,{container:c});
      }
      if(p==='/api/dev/container/save'&&req.method==='POST'){
        if(!c||!mine(c))return bad(res,'Container not found',404);
        c.pages=sanitizePages(body.pages);
        if(body.name)c.name=String(body.name).slice(0,40);
        if(c.status==='submitted'&&!M.admin){c.status='draft';}  /* edits after submission need re-approval */
        c.updated=Date.now();saveS();
        return json(res,200,{ok:1,container:c});
      }
      if(p==='/api/dev/container/submit'&&req.method==='POST'){
        if(!c||!mine(c))return bad(res,'Container not found',404);
        if(c.status==='submitted')return bad(res,'Already awaiting approval');
        c.status='submitted';c.submittedTs=Date.now();saveS();
        notifyAdmins(`📤 Dev container "${c.name}" by ${c.owner} was submitted for approval — review it in the Dev Studio`);
        return json(res,200,{ok:1});
      }
      if(p==='/api/dev/container/withdraw'&&req.method==='POST'){
        if(!c||!mine(c))return bad(res,'Container not found',404);
        c.status='draft';saveS();
        return json(res,200,{ok:1});
      }
      if(p==='/api/dev/container/delete'&&req.method==='POST'){
        if(!c||!mine(c))return bad(res,'Container not found',404);
        misc.containers=misc.containers.filter(x=>x!==c);saveS();
        return json(res,200,{ok:1});
      }
    }
    return bad(res,'Unknown dev endpoint',404);
  }

  /* ================= admin ================= */
  if(p.startsWith('/api/admin/')){
    if(!M.admin)return bad(res,'Admin only',403);
    if(p==='/api/admin/metrics'&&req.method==='GET'){
      const players=Object.keys(users).map(pub).sort((a,b)=>b.elo-a.elo);
      return json(res,200,{metrics:{
        uptimeMs:Date.now()-BOOT,serverStart:BOOT,firstStart:metrics.firstStart,
        totalUsers:Object.keys(users).length,
        onlineNow:new Set(Object.values(sessions).filter(s=>s.exp>Date.now()).map(s=>s.user)).size,
        registrations:metrics.registrations,logins:metrics.logins,
        gamesFinished:metrics.gamesFinished,eventsRelayed:metrics.eventsRelayed,
        savedMatches:Object.keys(saved).length,
        openMatches:Object.values(matches).filter(m=>m.status==='open').length,
        activeMatches:Object.values(matches).filter(m=>m.status==='active').length,
        feedbackCount:misc.feedback.length,
        smtp:misc.smtp?{host:misc.smtp.host,user:misc.smtp.user,from:misc.smtp.from||misc.smtp.user}:null,
        mailLog:mailLog.slice(0,10),
        known:misc.knownIssues.filter(k=>k.status==='open').slice(0,10)},
        users:players.map(pl=>({...pl,admin:users[pl.user].admin,staff:users[pl.user].staff,dev:!!users[pl.user].dev,
          banned:users[pl.user].banned||null,flagged:users[pl.user].flagged||null})),
        recent:Object.values(saved).sort((a,b)=>b.ended-a.ended).slice(0,15).map(r=>matchSummary(r)),
        support:misc.support.filter(s=>!s.done).slice(0,20)
          .map(s=>({...s,emailLinked:!!(users[s.user]&&users[s.user].email)}))});
    }
    if(p==='/api/admin/smtp'&&req.method==='POST'){
      let host=String(body.host||'').trim();
      const smtpUser=String(body.user||'').trim();
      if(!host&&!smtpUser){misc.smtp=null;saveS();return json(res,200,{ok:1,configured:false});}
      if(host.includes('@'))
        return bad(res,'The SMTP host must be a server name, not an email address. For Gmail and Google Workspace domains use smtp.gmail.com — or just leave the host blank and I will use it automatically.');
      if(!smtpUser||!smtpUser.includes('@'))
        return bad(res,'Enter the full email address you are sending from');
      if(String(body.pass||'').trim().startsWith('SG.'))host='sendgrid';  /* HTTP API mode */
      else if(!host)host='smtp.gmail.com';   /* Google-managed mail (gmail + custom Google domains) */
      misc.smtp={host,port:+body.port||465,user:smtpUser,plain:!!body.plain,
        pass:body.pass?String(body.pass).replace(/\s+/g,''):(misc.smtp?misc.smtp.pass:''),
        from:String(body.from||'').trim()||smtpUser};
      if(!misc.smtp.pass)return bad(res,'Enter the app password');
      saveS();
      console.log('email service linked:',misc.smtp.user,'via',misc.smtp.host);
      return json(res,200,{ok:1,configured:true,host});
    }
    if(p==='/api/admin/smtpTest'&&req.method==='POST'){
      const to=String(body.to||'').trim();
      if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to))return bad(res,'Enter a valid email address to send the test to');
      try{await sendMail(to,'KARN email service test','Your KARN server can send email. Recovery codes will work.');}
      catch(e){return bad(res,'Test failed: '+e.message);}
      return json(res,200,{ok:1});
    }
    if(p==='/api/admin/emailCode'&&req.method==='POST'){
      const t=findUser(body.user);
      if(!t)return bad(res,'No such player');
      const em=users[t].email;
      if(!em)return bad(res,'That player has no recovery email linked');
      const code=makeRecovery(t,me);
      try{
        const bodyTxt=`An admin sent you an account recovery code. Use it via "Account recovery" on the login screen to set a new password or username.`;
        await sendMail(em,'[KARN] Account recovery code',
          mailTemplate('Account recovery',t,bodyTxt,null,{code}),
          mailHTML('Account recovery',t,bodyTxt,null,{code}));
      }catch(e){delete misc.recov[code];saveS();return bad(res,'Email failed: '+e.message);}
      for(const s2 of misc.support)if(s2.user===t)s2.done=true;
      saveS();
      return json(res,200,{ok:1,hint:maskEmail(em)});
    }
    if(p==='/api/admin/balance'&&req.method==='POST'){
      misc.balance=sanitizeBalance(body.balance);
      misc.balV++;saveS();
      console.log('game balance updated by',me,misc.balance?'(custom)':'(defaults)');
      return json(res,200,{ok:1,balance:misc.balance,v:misc.balV});
    }
    if(p==='/api/admin/pages'&&req.method==='POST'){
      misc.pages=sanitizePages(body.pages);
      misc.balV++;saveS();
      console.log('site pages updated by',me,'-',misc.pages.custom.length,'custom tab(s)');
      return json(res,200,{ok:1,pages:misc.pages,v:misc.balV});
    }
    if(p==='/api/admin/balance/reset'&&req.method==='POST'){
      misc.balance=null;misc.balV++;saveS();
      console.log('game balance reset to defaults by',me);
      return json(res,200,{ok:1,v:misc.balV});
    }
    if(p==='/api/admin/support/resolve'&&req.method==='POST'){
      for(const s2 of misc.support)if(s2.id===+body.id)s2.done=true;
      saveS();
      return json(res,200,{ok:1});
    }

    /* ---- encrypted credential vault (admin only) ---- */
    if(p==='/api/admin/vault/status'&&req.method==='GET')
      return json(res,200,{exists:!!vaultFile,unlocked:!!vaultKeys[token]});
    if(p==='/api/admin/vault/setup'&&req.method==='POST'){
      /* create the vault with a fresh master passphrase (only if none exists) */
      if(vaultFile)return bad(res,'Vault already exists — unlock it instead');
      const pass=String(body.pass||'');
      if(pass.length<8)return bad(res,'Master passphrase must be at least 8 characters');
      const salt=crypto.randomBytes(16);
      vaultFile={v:1,salt:salt.toString('hex'),iv:'',tag:'',ct:''};
      const key=deriveVaultKey(pass,salt);
      vaultEncrypt(key,[]);
      vaultKeys[token]=key;
      console.log('credential vault created by',me);
      return json(res,200,{ok:1,unlocked:true});
    }
    if(p==='/api/admin/vault/unlock'&&req.method==='POST'){
      if(!vaultFile)return bad(res,'No vault yet — set one up first');
      if(!rate(ip+':vault',10,5*60e3))return bad(res,'Too many attempts — wait a few minutes',429);
      const key=deriveVaultKey(String(body.pass||''),Buffer.from(vaultFile.salt,'hex'));
      try{vaultDecrypt(key);}catch(e){return bad(res,'Wrong master passphrase',401);}
      vaultKeys[token]=key;
      return json(res,200,{ok:1,unlocked:true});
    }
    if(p==='/api/admin/vault/lock'&&req.method==='POST'){delete vaultKeys[token];return json(res,200,{ok:1});}
    /* everything below requires an unlocked key held in memory for this session */
    if(p.startsWith('/api/admin/vault/')){
      const key=vaultKeys[token];
      if(!key)return bad(res,'Vault is locked',403);
      let entries;
      try{entries=vaultDecrypt(key);}catch(e){delete vaultKeys[token];return bad(res,'Vault is locked',403);}
      if(p==='/api/admin/vault/list')                 /* redacted: no passwords */
        return json(res,200,{entries:vaultRedact(entries)});
      if(p==='/api/admin/vault/reveal'&&req.method==='POST'){
        const e=entries.find(x=>x.id===String(body.id));
        if(!e)return bad(res,'Not found');
        return json(res,200,{pass:e.pass||''});
      }
      if(p==='/api/admin/vault/save'&&req.method==='POST'){
        const label=String(body.label||'').trim().slice(0,80);
        const email=String(body.email||'').trim().slice(0,254);
        const pass=body.pass!=null?String(body.pass).slice(0,256):null;
        const notes=String(body.notes||'').slice(0,500);
        if(!label&&!email)return bad(res,'Give the entry a label or email');
        if(body.id){
          const e=entries.find(x=>x.id===String(body.id));
          if(!e)return bad(res,'Not found');
          e.label=label;e.email=email;e.notes=notes;e.updated=Date.now();
          if(pass!=null&&pass!=='')e.pass=pass;         /* blank = keep existing */
        }else{
          entries.push({id:crypto.randomBytes(6).toString('hex'),label,email,
            pass:pass||'',notes,updated:Date.now()});
        }
        vaultEncrypt(key,entries);
        return json(res,200,{ok:1,entries:vaultRedact(entries)});
      }
      if(p==='/api/admin/vault/delete'&&req.method==='POST'){
        entries=entries.filter(x=>x.id!==String(body.id));
        vaultEncrypt(key,entries);
        return json(res,200,{ok:1,entries:vaultRedact(entries)});
      }
      return bad(res,'Unknown vault endpoint',404);
    }
    if(p==='/api/admin/feedback'&&req.method==='GET')return json(res,200,{feedback:misc.feedback});
    if(p==='/api/admin/feedback/delete'&&req.method==='POST'){
      misc.feedback=misc.feedback.filter(f=>f.id!==+body.id);saveS();
      return json(res,200,{ok:1});
    }
    if(p==='/api/admin/setStaff'&&req.method==='POST'){
      const t=findUser(body.user);
      if(!t)return bad(res,'No such player');
      if(users[t].admin)return bad(res,'Admins already have full powers');
      users[t].staff=!!body.staff;
      users[t].rank=body.staff?Math.max(users[t].rank||0,2):0;
      if(!body.staff)users[t].manager=null;
      saveU();
      addNotif(t,{type:'info',text:body.staff
        ?'🧰 You have been made STAFF — the Staff page is now in your side menu'
        :'Your staff role was removed'});
      return json(res,200,{ok:1});
    }
    if(p==='/api/admin/container/reject'&&req.method==='POST'){
      const c=misc.containers.find(x=>x.id===+body.id);
      if(!c)return bad(res,'Container not found',404);
      c.status='draft';saveS();
      if(users[c.owner])addNotif(c.owner,{type:'info',
        text:`📪 Your dev container "${c.name}" was not approved${body.reason?': "'+String(body.reason).slice(0,140)+'"':''} — it's back in draft, edit and resubmit any time`});
      return json(res,200,{ok:1});
    }
    if(p==='/api/admin/container/publish'&&req.method==='POST'){
      const c=misc.containers.find(x=>x.id===+body.id);
      if(!c)return bad(res,'Container not found',404);
      if((c.status||'draft')!=='submitted'&&c.owner!==me)
        return bad(res,'This container has not been submitted for approval yet');
      c.status='published';c.publishedTs=Date.now();
      misc.pages=sanitizePages(c.pages);
      misc.balV++;saveS();
      if(users[c.owner]&&c.owner!==me)
        addNotif(c.owner,{type:'info',text:`🚀 Your dev container "${c.name}" was published to the live site by ${me}`});
      console.log('dev container',c.id,'('+c.name+') published by',me);
      return json(res,200,{ok:1,pages:misc.pages});
    }
    if(p==='/api/admin/setdev'&&req.method==='POST'){
      const t=findUser(body.user);
      if(!t)return bad(res,'No such player');
      if(users[t].admin)return bad(res,'Admins already have full powers');
      users[t].dev=!!body.dev;saveU();
      addNotif(t,{type:'info',text:body.dev
        ?'🧪 You are now a DEVELOPER — the Dev Studio is in your side menu. Your work lives in private dev containers until the admin publishes it.'
        :'Your developer role was removed'});
      return json(res,200,{ok:1});
    }
    if(p==='/api/admin/ban'&&req.method==='POST'){
      const t=findUser(body.user);
      if(!t)return bad(res,'No such player');
      if(users[t].admin)return bad(res,'Cannot ban an admin');
      users[t].banned={by:me,reason:String(body.reason||'').slice(0,140),ts:Date.now()};
      if(body.banDevice!==false){   /* block their device(s) from making new accounts */
        let n=0;
        for(const id in misc.devices){
          const D=misc.devices[id];
          if(D.users.includes(t)){
            D.banned=true;
            D.bannedFor=D.bannedFor||[];
            if(!D.bannedFor.includes(t))D.bannedFor.push(t);
            n++;
          }
        }
        if(n)console.log('device ban:',n,'device(s) of',t,'blocked from new accounts');
        saveS();
      }
      sendUserMail(t,'[KARN] Your account has been suspended','Account suspended',
        `Your KARN account "${t}" has been suspended by the server administrator.\n\n`+
        (body.reason?`Reason given:\n    ${String(body.reason).slice(0,140)}\n\n`:'')+
        `You will not be able to log in while the suspension is active.\n`+
        `If you believe this is a mistake, contact the server administrator.`);
      for(const tk in sessions)if(sessions[tk].user===t)delete sessions[tk];
      dequeue(t);
      const cur=activeMatchOf(t);
      if(cur&&cur.status==='open')delete matches[cur.id];
      for(const id in challenges)if(challenges[id].from===t||challenges[id].to===t)delete challenges[id];
      saveU();console.log('BAN',t,'by',me,body.reason?('('+body.reason+')'):'');
      return json(res,200,{ok:1});
    }
    if(p==='/api/admin/unban'&&req.method==='POST'){
      const t=findUser(body.user);
      if(!t)return bad(res,'No such player');
      users[t].banned=null;saveU();
      for(const id in misc.devices){   /* lift matching device blocks */
        const D=misc.devices[id];
        if(D.bannedFor&&D.bannedFor.includes(t)){
          D.bannedFor=D.bannedFor.filter(n=>n!==t);
          if(!D.bannedFor.length)D.banned=false;
        }
      }
      saveS();
      return json(res,200,{ok:1});
    }
    if(p==='/api/admin/known/resolve'&&req.method==='POST'){
      const ki=misc.knownIssues.find(k=>k.id===+body.id);
      if(ki&&ki.status==='open'){
        ki.status='resolved';
        for(const tid of ki.tids){
          const tk=misc.tickets.find(x=>x.id===tid);
          if(tk&&tk.status==='open'&&tk.from==='support'){
            tk.status='closed';tk.closedBy='KARN Assistant';
            tk.messages.push({by:'KARN Assistant',text:`Good news — the known problem this ticket was merged into (KP-${ki.id}: "${ki.title}") has been fixed. Thanks for reporting it!`,ts:Date.now()});
            if(users[tk.to]){
              addNotif(tk.to,{type:'ticket',from:'KARN Assistant',data:{tid:tk.id},text:`Known problem KP-${ki.id} is fixed — ticket #${tk.id} closed`});
              sendUserMail(tk.to,`[KARN] Fixed: the problem you reported`,`KP-${ki.id} resolved`,
                `The problem you reported ("${ki.title}") has been fixed. Thanks for helping make KARN better!`,null);
            }
          }
        }
        saveS();
      }
      return json(res,200,{ok:1});
    }
    if(p==='/api/admin/untag'&&req.method==='POST'){
      const t=findUser(body.user);
      if(t){users[t].flagged=null;saveU();}
      return json(res,200,{ok:1});
    }
    if(p==='/api/admin/edit'&&req.method==='POST'){
      const t=findUser(body.user);
      if(!t)return bad(res,'No such player');
      if(users[t].admin&&t!==me)return bad(res,'Cannot edit another admin');
      if(body.elo!=null&&body.elo!==''){
        const e=Math.round(+body.elo);
        if(!(e>=100&&e<=3500))return bad(res,'Elo must be 100-3500');
        users[t].elo=e;
      }
      let name=t;
      const nn=String(body.newName||'').trim();
      if(nn&&nn!==t){
        if(!/^[A-Za-z0-9_]{2,16}$/.test(nn))return bad(res,'Username: 2-16 letters, numbers or _');
        if(findUser(nn))return bad(res,'That username is taken');
        renameUser(t,nn);name=nn;
        addNotif(name,{type:'info',text:'An admin changed your username to '+name});
      }
      saveU();
      return json(res,200,{ok:1,user:name});
    }
    if(p==='/api/admin/deleteUser'&&req.method==='POST'){
      const t=findUser(body.user);
      if(!t)return bad(res,'No such player');
      if(users[t].admin)return bad(res,'Cannot delete an admin account');
      delete users[t];
      for(const tk in sessions)if(sessions[tk].user===t)delete sessions[tk];
      for(const id in challenges)if(challenges[id].from===t||challenges[id].to===t)delete challenges[id];
      for(const u in users){const x=users[u];
        x.friends=x.friends.filter(n=>n!==t);x.reqIn=x.reqIn.filter(n=>n!==t);
        x.reqOut=x.reqOut.filter(n=>n!==t);x.blocked=x.blocked.filter(n=>n!==t);}
      saveU();console.log('admin',me,'deleted user',t);
      return json(res,200,{ok:1});
    }
    if(p==='/api/admin/setPass'&&req.method==='POST'){
      const t=findUser(body.user);
      if(!t)return bad(res,'No such player');
      if(String(body.pass||'').length<4)return bad(res,'Password must be at least 4 characters');
      const{salt,hash}=hashPass(String(body.pass));
      users[t].salt=salt;users[t].hash=hash;
      addNotif(t,{type:'info',text:'An admin changed your password'});
      saveU();console.log('admin',me,'changed password of',t);
      return json(res,200,{ok:1});
    }
    if(p==='/api/admin/deleteMatch'&&req.method==='POST'){
      const id=String(body.id);
      if(saved[id]){delete saved[id];
        for(const u in users)users[u].matches=users[u].matches.filter(x=>x!==id);
        saveM();saveU();}
      return json(res,200,{ok:1});
    }
  }

  /* ================= live match relay ================= */
  const mm=p.match(/^\/api\/match\/(\w+)(?:\/(\w+))?$/);
  if(mm){
    const m=matches[mm[1]];
    if(!m)return bad(res,'Match not found',404);
    if(m.host!==me&&m.guest!==me)return bad(res,'Not your match',403);
    const side=m.host===me?0:1;
    const sub=mm[2]||'';
    if(!sub&&req.method==='GET'){
      const since=+(url.searchParams.get('since')||0);
      m.last=Date.now();
      return json(res,200,{...matchInfo(m,me),events:m.events.slice(since)});
    }
    if(sub==='event'&&req.method==='POST'){
      if(m.status!=='active')return bad(res,'Match is not active');
      if(m.events.length>=4000)return bad(res,'Match event limit reached');
      const ev={n:m.events.length+1,by:side,type:String(body.type||'').slice(0,20),data:body.data??null};
      m.events.push(ev);m.last=Date.now();
      if(ev.type==='setup'){                    /* setup clocks */
        if(side===0)m.wSetupTs=Date.now();      /* Black's 4 minutes start now */
        else m.setupDone=true;
      }
      metrics.eventsRelayed++;
      return json(res,200,{n:ev.n});
    }
    if(sub==='timeout'&&req.method==='POST'){
      /* setup forfeit: 4 minutes per side to deploy, verified on the server clock */
      if(m.status==='done')return json(res,200,{result:m.result});
      if(m.mode!=='setup'||m.setupDone)return bad(res,'No setup timeout to claim');
      const pending=m.wSetupTs?1:0;
      const t0=pending===0?m.started:m.wSetupTs;
      if(Date.now()-t0<balRule('setupSecs',240)*1000)return bad(res,'They still have time on the setup clock');
      finalizeMatch(m,1-pending,pending);
      console.log('match',m.id,'setup timeout —',pending===0?m.host:m.guest,'forfeits');
      return json(res,200,{result:m.result});
    }
    if(sub==='result'&&req.method==='POST'){
      if(m.status==='done')return json(res,200,{result:m.result});
      const w=body.winner;
      if(w!==0&&w!==1&&w!=='draw')return bad(res,'Bad winner');
      finalizeMatch(m,w,null);
      return json(res,200,{result:m.result});
    }
    if(sub==='resign'&&req.method==='POST'){
      if(m.status==='done')return json(res,200,{result:m.result});
      finalizeMatch(m,1-side,side);
      return json(res,200,{result:m.result});
    }
    if(sub==='abort'&&req.method==='POST'){
      /* cancelling during setup: no Elo change, no record */
      if(m.status!=='active')return json(res,200,{ok:1});
      if(m.events.some(e=>e.type==='action'))return bad(res,'The battle has started — resign instead');
      const other=side===0?m.guest:m.host;
      delete matches[m.id];
      addNotif(other,{type:'info',text:`${me} cancelled the match during setup`});
      console.log('match',m.id,'aborted by',me);
      return json(res,200,{ok:1,aborted:true});
    }
  }
  return bad(res,'Unknown endpoint',404);
}catch(e){
  console.error(e);
  try{bad(res,'Server error',500);}catch(_){}
}
};
/* HTTPS if a certificate is provided:  node server.js --cert cert.pem --key key.pem */
const ci=process.argv.indexOf('--cert'),ki=process.argv.indexOf('--key');
const IS_TLS=ci>-1&&ki>-1;
if(IS_TLS)SEC_HEADERS['Strict-Transport-Security']='max-age=31536000';
const server=IS_TLS
  ?require('https').createServer({cert:fs.readFileSync(process.argv[ci+1]),key:fs.readFileSync(process.argv[ki+1])},handler)
  :http.createServer(handler);
const BOOT=Date.now();
server.listen(PORT,'0.0.0.0',()=>{
  console.log('');
  console.log('  ██╗  KARN battle server running');
  console.log('');
  console.log('  On this computer:  http://localhost:'+PORT+'/');
  const nets=os.networkInterfaces();
  for(const name in nets)for(const ni of nets[name]){
    if(ni.family==='IPv4'&&!ni.internal)
      console.log('  On your network:   http://'+ni.address+':'+PORT+'/   <- give this to friends');
  }
  console.log('');
  console.log('  Data is stored in the ./data folder. First account created = ADMIN.');
  console.log('  Press Ctrl+C to stop.');
});
