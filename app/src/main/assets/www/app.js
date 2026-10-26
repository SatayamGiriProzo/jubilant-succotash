"use strict";
/* SpeakUp 30 — app logic.
   Runs inside the Android app (window.Android bridge gives native speech + voice)
   or in any modern browser for testing (Web Speech API fallback). */

const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const NATIVE = (typeof window.Android !== "undefined" && window.Android) ? window.Android : null;
const MODELS = [["claude-haiku-5-5","Haiku 5.5 · fastest, lowest cost"],["claude-sonnet-5-5","Sonnet 5.5 · most detailed corrections"]];
const DEFAULT_MODEL = MODELS[0][0];

function localDate(d = new Date()){ const p = n => String(n).padStart(2,"0"); return d.getFullYear()+"-"+p(d.getMonth()+1)+"-"+p(d.getDate()); }
const today = () => localDate();
function rng(seed){ let h = 2166136261; for(const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return () => { h += 0x6D2B79F5; let t = h; t = Math.imul(t ^ t>>>15, t|1); t ^= t + Math.imul(t ^ t>>>7, t|61); return ((t ^ t>>>14)>>>0)/4294967296; }; }
function toast(msg){ const t = document.createElement("div"); t.className = "toast"; t.textContent = msg; document.body.appendChild(t); setTimeout(() => t.remove(), 2600); }

/* ================= storage ================= */
const Store = {
  get(k, d){ try{ const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); }catch(e){ return d; } },
  set(k, v){ try{ localStorage.setItem(k, JSON.stringify(v)); }catch(e){} },
  del(k){ try{ localStorage.removeItem(k); }catch(e){} }
};
let user = null;
const U = {
  get(k, d){ return user ? Store.get("u:"+user.id+":"+k, d) : d; },
  set(k, v){ if(user) Store.set("u:"+user.id+":"+k, v); }
};
const DEFAULTS = {apiKey:"", model:DEFAULT_MODEL, accent:"en-IN", rate:0.95, handsFree:true, speakCorrections:true, autoSend:true, goal:25, reminderOn:false, reminderTime:"19:00"};
function S(){ return Object.assign({}, DEFAULTS, U.get("settings", {})); }
function setS(patch){ U.set("settings", Object.assign(S(), patch)); }

/* ================= accounts ================= */
const b64e = u8 => btoa(String.fromCharCode(...u8));
const b64d = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
async function hashPw(pw, saltB64){
  const salt = saltB64 ? b64d(saltB64) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(pw), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({name:"PBKDF2", hash:"SHA-256", salt, iterations:120000}, key, 256);
  return {salt: b64e(salt), hash: b64e(new Uint8Array(bits))};
}
const accounts = () => Store.get("accounts", {});
const keyOf = email => String(email || "").trim().toLowerCase();
async function signUp({name, email, password, level}){
  const k = keyOf(email), acc = accounts();
  if(acc[k]) throw "An account with this email already exists on this phone. Log in instead.";
  const {salt, hash} = await hashPw(password);
  acc[k] = {id:"u"+Date.now().toString(36)+Math.random().toString(36).slice(2,6), name:name.trim(), email:email.trim(), level, salt, hash, created:today()};
  Store.set("accounts", acc); Store.set("session", k);
  return acc[k];
}
async function logIn(email, password){
  const a = accounts()[keyOf(email)];
  if(!a) throw "No account with that email on this phone. Check the spelling or create an account.";
  const {hash} = await hashPw(password, a.salt);
  if(hash !== a.hash) throw "That password is incorrect.";
  Store.set("session", keyOf(email));
  return a;
}
function logOut(){ stopAll(); Store.del("session"); user = null; renderAuth("login"); }

/* ================= progress ================= */
function todayDone(){ return U.get("done", {})[today()] || {}; }
function markDone(id, score){
  const done = U.get("done", {}); done[today()] = Object.assign({}, done[today()], {[id]: score}); U.set("done", done);
  const pr = U.get("practiced", []); if(!pr.includes(today())){ pr.push(today()); U.set("practiced", pr); }
}
// Days advance when you practise: miss a day and you continue where you stopped.
function dayInfo(){
  const t = today(), n = U.get("practiced", []).filter(d => d < t).length + 1, idx = Math.min(30, n);
  return {n, idx, theme: CURR[idx-1], bonus: n > 30};
}
function streak(){
  const pr = new Set(U.get("practiced", [])); let s = 0; const d = new Date();
  if(!pr.has(localDate(d))) d.setDate(d.getDate()-1);
  while(pr.has(localDate(d))){ s++; d.setDate(d.getDate()-1); }
  return s;
}
function avgScore(){
  const all = Object.values(U.get("done", {})).flatMap(o => Object.values(o)).filter(n => typeof n === "number");
  return all.length ? (all.reduce((a,b) => a+b, 0) / all.length).toFixed(1) : "–";
}
function logMistakes(list){
  const nb = U.get("notebook", []), d = dayInfo().n;
  list.forEach(m => nb.unshift({wrong:m.wrong, right:m.right, why:m.why, date:today(), day:d}));
  U.set("notebook", nb.slice(0, 400));
}

/* ================= Claude API ================= */
async function claude({system, messages, maxTokens = 1200}){
  const s = S();
  if(!s.apiKey) throw {code:"nokey"};
  let res;
  try{
    res = await fetch("https://api.anthropic.com/v1/messages", {
      method:"POST",
      headers:{"content-type":"application/json","x-api-key":s.apiKey,"anthropic-version":"2023-06-01","anthropic-dangerous-direct-browser-access":"true"},
      body: JSON.stringify(Object.assign({model: s.model || DEFAULT_MODEL, max_tokens: maxTokens, messages}, system ? {system} : {}))
    });
  }catch(e){ throw {code:"offline"}; }
  if(!res.ok){
    let msg = ""; try{ msg = ((await res.json()).error || {}).message || ""; }catch(e){}
    const code = res.status === 401 || res.status === 403 ? "badkey" : (res.status === 429 || res.status === 529 || res.status === 503) ? "busy" : (res.status === 404 || (res.status === 400 && /model/i.test(msg))) ? "model" : res.status === 400 && /credit|billing/i.test(msg) ? "credit" : "api";
    throw {code, status: res.status, message: msg};
  }
  const data = await res.json();
  return (data.content || []).filter(b => b.type === "text").map(b => b.text).join("");
}
function parseJSON(t){
  try{ return JSON.parse(t); }catch(e){}
  const m = t.match(/```(?:json)?\s*([\s\S]*?)```/); if(m){ try{ return JSON.parse(m[1]); }catch(e){} }
  const starts = ["{","["].map(c => t.indexOf(c)).filter(i => i >= 0), a = starts.length ? Math.min(...starts) : -1, b = Math.max(t.lastIndexOf("}"), t.lastIndexOf("]"));
  if(a >= 0 && b > a){ try{ return JSON.parse(t.slice(a, b+1)); }catch(e){} }
  throw {code:"json"};
}
async function claudeJSON(opts){ return parseJSON(await claude(opts)); }
function apiErrorText(e){
  return ({nokey:"Add your Claude API key in Profile to turn on the AI coach.", badkey:"Your Claude API key was rejected. Check it in Profile.", busy:"Claude is busy right now. Try again in a minute.", offline:"No internet connection. Using the built-in course for now.", model:"The selected AI model isn't available on your key. Pick another in Profile.", credit:"Your Claude account is out of credit. Add credit at console.anthropic.com.", json:"The AI reply came back garbled. Try again."})[e && e.code] || ("The AI coach had a problem" + (e && e.message ? ": " + e.message : ". Try again."));
}

/* ================= speech recognition ================= */
const Speech = (() => {
  let h = null, webRec = null;
  function emit(ev){
    if(!h) return;
    if(ev.type === "start") h.onStart && h.onStart();
    else if(ev.type === "level") h.onLevel && h.onLevel(ev.level);
    else if(ev.type === "partial") h.onPartial && h.onPartial(ev.text || "");
    else if(ev.type === "final"){ const x = h; h = null; x.onFinal && x.onFinal(ev.text || "", ev.confidence); }
    else if(ev.type === "error"){ const x = h; h = null; x.onError && x.onError(ev.code); }
  }
  window.onNativeSpeech = emit;
  function ensureMic(){
    if(!NATIVE) return Promise.resolve(true);
    try{ if(NATIVE.hasMic()) return Promise.resolve(true); }catch(e){ return Promise.resolve(false); }
    return new Promise(res => { window.onMicPermission = ok => { window.onMicPermission = null; res(!!ok); }; NATIVE.requestMic(); });
  }
  async function start(handlers){
    stop();
    Voice.stop();
    const ok = await ensureMic();
    if(!ok){ handlers.onError && handlers.onError(9); return; }
    h = handlers;
    const lang = S().accent;
    if(NATIVE){ NATIVE.startListening(lang); return; }
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if(!SR){ emit({type:"error", code:-1}); return; }
    let finalText = "", ended = false;
    const rec = webRec = new SR(); rec.lang = lang; rec.interimResults = true; rec.continuous = false;
    rec.onstart = () => emit({type:"start"});
    rec.onresult = e => { let t = "", fin = false; for(const r of e.results){ t += r[0].transcript; if(r.isFinal) fin = true; } if(fin) finalText = t; else emit({type:"partial", text:t}); };
    rec.onerror = e => { ended = true; emit({type:"error", code: e.error === "no-speech" ? 6 : (e.error === "not-allowed" || e.error === "service-not-allowed") ? 9 : 5}); };
    rec.onend = () => { if(webRec === rec) webRec = null; if(!ended){ ended = true; emit(finalText ? {type:"final", text:finalText, confidence:-1} : {type:"error", code:7}); } };
    try{ rec.start(); }catch(e){ emit({type:"error", code:5}); }
  }
  function finish(){ if(NATIVE){ try{ NATIVE.stopListening(); }catch(e){} } else if(webRec){ try{ webRec.stop(); }catch(e){} } }
  function stop(){
    h = null;
    if(NATIVE){ try{ NATIVE.cancelListening(); }catch(e){} }
    else if(webRec){ try{ webRec.abort(); }catch(e){} webRec = null; }
  }
  function available(){ if(NATIVE){ try{ return !!NATIVE.speechAvailable(); }catch(e){ return false; } } return !!(window.SpeechRecognition || window.webkitSpeechRecognition); }
  return {start, finish, stop, available, ensureMic};
})();
function speechErrorText(code){
  return ({1:"Network timeout. Check your internet and try again.", 2:"Network problem. Check your internet and try again.", 3:"The phone couldn't record audio. Try again.", 4:"The speech service had an error. Try again.", 5:"Couldn't start listening. Tap the mic again.", 6:"I didn't hear anything. Tap the mic and speak.", 7:"I couldn't catch that. Speak a little slower and clearer.", 8:"The mic is busy. Wait a second and tap again.", 9:"Microphone access is off. Allow it in the prompt, or in Settings › Apps › SpeakUp 30 › Permissions.", 11:"Speech recognition for this accent isn't installed. Try another accent in Profile.", 12:"Speech recognition for this accent isn't installed. Try another accent in Profile.", 13:"Speech recognition for this accent isn't installed. Try another accent in Profile.", "-1":"Speech recognition isn't available on this phone. Install or update the Google app, then try again."})[code] || "The mic had a problem. Tap it to try again.";
}

/* ================= text to speech ================= */
const Voice = (() => {
  let seq = 0; const cbs = {};
  window.onNativeTts = (type, id) => { const cb = cbs[id]; delete cbs[id]; if(cb && type !== "stop") cb(); };
  function speak(text, onDone){
    const id = "t" + (++seq); if(onDone) cbs[id] = onDone;
    const s = S();
    if(NATIVE){ try{ NATIVE.speak(String(text), s.accent, Number(s.rate), id); return; }catch(e){} }
    if(window.speechSynthesis){
      try{ speechSynthesis.cancel(); const u = new SpeechSynthesisUtterance(String(text)); u.lang = s.accent; u.rate = s.rate;
        u.onend = () => window.onNativeTts("done", id); u.onerror = () => window.onNativeTts("stop", id); speechSynthesis.speak(u); return; }catch(e){}
    }
    setTimeout(() => window.onNativeTts("done", id), 0);
  }
  function speakSeq(list, onDone){ const items = list.filter(t => t && String(t).trim()); let i = 0; const next = () => { if(i >= items.length){ onDone && onDone(); return; } speak(items[i++], next); }; next(); }
  function stop(){ for(const k in cbs) delete cbs[k]; if(NATIVE){ try{ NATIVE.stopSpeaking(); }catch(e){} } else if(window.speechSynthesis){ try{ speechSynthesis.cancel(); }catch(e){} } }
  return {speak, speakSeq, stop};
})();

/* ================= mistake checking ================= */
function normalizeFix(r, user, model){
  const mistakes = Array.isArray(r.mistakes) ? r.mistakes.filter(m => m && (m.wrong || m.right)).slice(0, 4).map(m => ({wrong:String(m.wrong || ""), right:String(m.right || ""), why:String(m.why || "")})) : [];
  let score = Number(r.score); if(!isFinite(score)) score = mistakes.length ? Math.max(4, 10 - 2*mistakes.length) : 10;
  return {ok: mistakes.length === 0, score: Math.max(0, Math.min(10, Math.round(score))), mistakes, corrected: String(r.corrected || user), natural: String(r.natural || model || ""), praise: String(r.praise || ""), ai: true};
}
const PAST = {went:"go",came:"come",saw:"see",ate:"eat",took:"take",gave:"give",bought:"buy",did:"do",told:"tell",made:"make",got:"get",wrote:"write",spoke:"speak"};
const RULES = [
  [/\b(i|we|they|you) (am|are|is) agree\b/i, m => m[1]+" agree", "‘Agree’ is a verb, so don’t put am/is/are before it."],
  [/\bdiscuss about\b/i, () => "discuss", "‘Discuss’ doesn’t take ‘about’."],
  [/\breturn back\b/i, () => "return", "‘Return’ already means ‘go back’."],
  [/\brevert back\b/i, () => "get back", "In conversation, say ‘get back to you’ or ‘reply’."],
  [/\bcousin (brother|sister)\b/i, () => "cousin", "In English, ‘cousin’ covers both."],
  [/\bmore (better|worse|bigger|smaller|easier|faster)\b/i, m => m[1], "This word is already comparative, so drop ‘more’."],
  [/\bsince (\d+|one|two|three|four|five|six|many|few) (years?|months?|days?|weeks?|hours?)\b/i, m => "for "+m[1]+" "+m[2], "Use ‘for’ with a length of time and ‘since’ with a starting point."],
  [/\b(he|she|it) don'?t\b/i, m => m[1]+" doesn’t", "With he/she/it, use ‘doesn’t’."],
  [/\b(he|she|it) have\b/i, m => m[1]+" has", "With he/she/it, use ‘has’."],
  [/\bdid(n'?t| not)? (went|came|saw|ate|took|gave|bought|did|told|made|got|wrote|spoke)\b/i, m => "did"+(m[1] || "")+" "+PAST[m[2].toLowerCase()], "After ‘did’, use the base verb."],
  [/^\s*myself ([a-z]+)/i, m => "I’m "+m[1], "Introduce yourself with ‘I’m…’ or ‘My name is…’."],
  [/\bwhat is your good name\b/i, () => "what’s your name", "‘Good name’ sounds unusual outside India."],
  [/\bprepone\b/i, () => "bring forward", "‘Prepone’ isn’t understood everywhere, so say ‘bring forward’."],
  [/\bpassed out (of|from) (college|school|university)\b/i, m => "graduated from "+m[2], "‘Passed out’ means fainted, so say ‘graduated from’."],
  [/\b(advices|informations|furnitures|luggages|equipments)\b/i, m => m[1].replace(/s$/i, ""), "This noun is uncountable, so it has no -s."],
  [/\bmany (money|information|advice|luggage|work|traffic)\b/i, m => "a lot of "+m[1], "Use ‘a lot of’ or ‘much’ with uncountable nouns."],
  [/\b(i|we|they) (am|are) having (a |an |two |one )?(car|house|brother|sister|laptop|phone|bike|son|daughter)\b/i, m => m[1]+" have "+(m[3] || "")+m[4], "For possession, use ‘have’, not ‘am having’."],
  [/\ba ([aeio]\w+)/i, m => "an "+m[1], "Use ‘an’ before a vowel sound.", m => !/^(one|uni|use|usu|euro)/i.test(m[1])],
  [/\ban ([bcdfgjklmnpqrstvwxyz]\w+)/i, m => "a "+m[1], "Use ‘a’ before a consonant sound.", m => !/^(hour|honest|honou?r|heir|mba|fir|mla|sms|x)/i.test(m[1])],
  [/\bi am knowing\b/i, () => "I know", "‘Know’ isn’t used in the -ing form."],
  [/\bcan able to\b/i, () => "can", "Use ‘can’ or ‘am able to’, not both."],
  [/\bthe (\w+) is having\b/i, m => "the "+m[1]+" has", "For possession, use ‘has’."]
];
function localCheck(text, model){
  const mistakes = []; let corrected = text;
  for(const [re, fix, why, cond] of RULES){
    const m = corrected.match(re);
    if(m && (!cond || cond(m))){ const right = fix(m); mistakes.push({wrong:m[0].trim(), right, why}); corrected = corrected.replace(m[0], m[0].match(/^\s*/)[0] + right); }
  }
  if(text.trim().split(/\s+/).filter(Boolean).length < 3 && model) mistakes.push({wrong:text.trim(), right:model, why:"Try a full sentence. One-word answers sound abrupt in conversation."});
  return {ok: mistakes.length === 0, score: Math.max(3, 10 - 2*mistakes.length), mistakes, corrected, natural: model || "", praise: mistakes.length ? "" : "Clear and correct.", ai:false};
}
async function checkReply(text, ctx){
  const d = dayInfo();
  if(S().apiKey){
    const prompt = `You are a friendly English speaking coach for ${user.name}, an Indian learner (CEFR ${d.theme[2]}, Day ${d.idx} of 30: ${d.theme[0]}).
Situation: ${ctx.situation}
Conversation so far:
${ctx.history}
The partner just said: "${ctx.partnerLine}"
A model reply would be: "${ctx.model}"
The learner said (captured by speech recognition): "${text}"

Check the learner's reply as SPOKEN English. Find real mistakes in grammar, word choice, word order, tense, articles and prepositions, and Indian-English habits that sound unnatural to international listeners (e.g. "I am agree", "discuss about", "since 2 years", "cousin brother", "revert back", "myself Rahul"). Ignore capitalisation, punctuation and spelling, because this came from speech recognition. Also flag it if the reply doesn't answer the partner. Any reasonable answer is fine; it does not need to match the model. Max 3 mistakes, most important first.
Reply with ONLY JSON: {"score": 0-10, "mistakes": [{"wrong": "exact words from learner", "right": "fix", "why": "one simple sentence"}], "corrected": "the learner's sentence fixed with minimal changes", "natural": "how a fluent speaker might say it", "praise": "max 6 words of encouragement"}`;
    try{ return normalizeFix(await claudeJSON({messages:[{role:"user", content:prompt}], maxTokens:700}), text, ctx.model); }
    catch(e){ lastAiError = e; }
  }
  return localCheck(text, ctx.model);
}
let lastAiError = null;

/* ================= pronunciation drill ================= */
const CONTRACTIONS = {"i'm":"i am","it's":"it is","don't":"do not","doesn't":"does not","didn't":"did not","can't":"can not","cannot":"can not","won't":"will not","i'll":"i will","i'd":"i would","i've":"i have","you're":"you are","we're":"we are","they're":"they are","that's":"that is","what's":"what is","there's":"there is","isn't":"is not","aren't":"are not","wasn't":"was not","let's":"let us","you'll":"you will","we'll":"we will","he's":"he is","she's":"she is","haven't":"have not","couldn't":"could not","wouldn't":"would not","shouldn't":"should not"};
function words(s){ return String(s).toLowerCase().replace(/[’‘]/g, "'").replace(/[^a-z0-9' ]+/g, " ").split(/\s+/).filter(Boolean).flatMap(w => (CONTRACTIONS[w] || w.replace(/'/g, "")).split(" ")); }
function compareSpeech(target, said){
  const t = words(target), s = words(said), dp = Array.from({length:t.length+1}, () => new Array(s.length+1).fill(0));
  for(let i = t.length-1; i >= 0; i--) for(let j = s.length-1; j >= 0; j--) dp[i][j] = t[i] === s[j] ? dp[i+1][j+1] + 1 : Math.max(dp[i+1][j], dp[i][j+1]);
  const hit = new Array(t.length).fill(false); let i = 0, j = 0;
  while(i < t.length && j < s.length){ if(t[i] === s[j]){ hit[i] = true; i++; j++; } else if(dp[i+1][j] >= dp[i][j+1]) i++; else j++; }
  const n = hit.filter(Boolean).length;
  return {score: t.length ? Math.round(100*n/t.length) : 0, html: t.map((w,k) => `<span class="${hit[k] ? "hit" : "miss"}">${esc(w)}</span>`).join(" "), missed: t.filter((w,k) => !hit[k])};
}
function drill(target, box, btn){
  const tok = screenToken;
  btn.disabled = true; btn.textContent = "Listening…";
  box.hidden = false; box.innerHTML = `<span class="muted">Say: “${esc(target)}”</span>`;
  Speech.start({
    onPartial(t){ if(tok === screenToken) box.innerHTML = `<span class="muted">${esc(t)}</span>`; },
    onFinal(t){ if(tok !== screenToken) return; btn.disabled = false; btn.textContent = "Try again";
      const r = compareSpeech(target, t);
      box.innerHTML = `<div><b class="num">${r.score}%</b> match · ${r.score >= 90 ? "Excellent pronunciation." : r.score >= 70 ? "Good. Practise the red words." : "Say it slowly, word by word."}</div><div>${r.html}</div>`; },
    onError(c){ if(tok !== screenToken) return; btn.disabled = false; btn.textContent = "Try again"; box.innerHTML = `<span class="muted">${esc(speechErrorText(c))}</span>`; }
  });
}

/* ================= icons ================= */
const svg = p => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
const I = {
  today: svg('<path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01"/>'),
  mic: svg('<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0M12 17v4M8 21h8"/>'),
  book: svg('<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V2H6.5A2.5 2.5 0 0 0 4 4.5v15z"/><path d="M20 17v5H6.5A2.5 2.5 0 0 1 4 19.5"/>'),
  plan: svg('<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>'),
  user: svg('<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>'),
  speaker: svg('<path d="M11 5 6 9H2v6h4l5 4V5z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M19 5a9 9 0 0 1 0 14"/>'),
  stop: svg('<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/>'),
  spin: svg('<path d="M21 12a9 9 0 1 1-6.2-8.56"/>'),
  back: svg('<path d="M15 18l-6-6 6-6"/>'),
  send: svg('<path d="M22 2 11 13M22 2l-7 20-4-9-9-4 20-7z"/>')
};
const BUBBLE_LOGO = `<svg viewBox="24 24 60 60" aria-hidden="true"><path fill="#fff" d="M38,32h32a8,8 0 0 1 8,8v22a8,8 0 0 1 -8,8h-18l-12,10v-10h-2a8,8 0 0 1 -8,-8v-22a8,8 0 0 1 8,-8z"/><path fill="#0D6B66" d="M42,47h4v8h-4z M50,42h4v18h-4z M58,45h4v12h-4z M66,48h4v6h-4z"/></svg>`;

/* ================= auth screens ================= */
function renderAuth(mode){
  document.body.classList.remove("typing");
  const accs = Object.values(accounts());
  $("app").innerHTML = `<div class="auth">
    <div class="brand"><div class="logo">${BUBBLE_LOGO}</div><h1>SpeakUp 30</h1>
      <p>Speak English with confidence in 30 days. Talk out loud, get corrected instantly, and practise 50 new conversations every day.</p></div>
    <div class="seg"><button id="mSignup" class="${mode === "signup" ? "on" : ""}">Create account</button><button id="mLogin" class="${mode === "login" ? "on" : ""}">Log in</button></div>
    <form class="form" id="authForm" novalidate>
      ${mode === "signup" ? `<label class="field"><span>Your name</span><input class="input" id="fName" autocomplete="name" placeholder="e.g. Priya Sharma"></label>` : ""}
      <label class="field"><span>Email</span><input class="input" id="fEmail" type="email" autocomplete="email" inputmode="email" placeholder="you@example.com"></label>
      <label class="field"><span>Password</span><input class="input" id="fPass" type="password" autocomplete="${mode === "signup" ? "new-password" : "current-password"}" placeholder="${mode === "signup" ? "At least 6 characters" : "Your password"}"></label>
      ${mode === "signup" ? `<div class="field"><span>Your English right now</span><div class="levels">
        <label><input type="radio" name="lvl" value="Beginner" checked>Beginner<small>Few words</small></label>
        <label><input type="radio" name="lvl" value="Elementary">Basic<small>Simple sentences</small></label>
        <label><input type="radio" name="lvl" value="Intermediate">Okay<small>Can chat a bit</small></label></div></div>` : ""}
      <div class="err" id="authErr" role="alert"></div>
      <button class="btn primary big" id="authBtn">${mode === "signup" ? "Create account" : "Log in"}</button>
    </form>
    ${mode === "login" && accs.length ? `<div class="stack" style="gap:8px"><p class="fine">Accounts on this phone</p><div class="quick">${accs.map(a => `<button class="btn small" data-email="${esc(a.email)}">${esc(a.name)}</button>`).join("")}</div></div>` : ""}
    <p class="fine">Accounts and progress are saved privately on this phone. Several people can share one phone, each with their own account.</p>
  </div>`;
  $("mSignup").onclick = () => renderAuth("signup");
  $("mLogin").onclick = () => renderAuth("login");
  document.querySelectorAll("[data-email]").forEach(b => b.onclick = () => { $("fEmail").value = b.dataset.email; $("fPass").focus(); });
  $("authForm").onsubmit = async e => {
    e.preventDefault();
    const err = $("authErr"), email = $("fEmail").value.trim(), pass = $("fPass").value;
    err.textContent = "";
    if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return err.textContent = "Enter a valid email address.";
    if(mode === "signup"){
      const name = $("fName").value.trim();
      if(name.length < 2) return err.textContent = "Enter your name.";
      if(pass.length < 6) return err.textContent = "Use a password of at least 6 characters.";
    } else if(!pass) return err.textContent = "Enter your password.";
    $("authBtn").disabled = true;
    try{
      user = mode === "signup"
        ? await signUp({name:$("fName").value, email, password:pass, level:(document.querySelector("[name=lvl]:checked") || {}).value || "Beginner"})
        : await logIn(email, pass);
      enterApp();
    }catch(x){ err.textContent = typeof x === "string" ? x : "Something went wrong. Try again."; $("authBtn").disabled = false; }
  };
}

/* ================= shell ================= */
const NAV = [["today","Today",I.today],["talk","Talk",I.mic],["notebook","Mistakes",I.book],["plan","Plan",I.plan],["profile","Profile",I.user]];
let tab = "today", screenToken = 0, practice = null, lastDate = null, onStopAll = null;
function stopAll(){ screenToken++; Speech.stop(); Voice.stop(); const f = onStopAll; onStopAll = null; f && f(); }
function enterApp(){
  lastDate = today();
  $("app").innerHTML = `<div class="shell">
    <header class="appbar"><div class="ab-main"><div class="label" id="abEyebrow"></div><div class="ab-title" id="abTitle"></div></div>
      <div class="ab-stats"><div><b class="num" id="abStreak">0</b><span>streak</span></div><div><b class="num" id="abToday">0</b><span>today</span></div></div></header>
    <div class="track" id="track" aria-hidden="true"></div>
    <main class="view" id="view"></main>
    <nav class="bottom" id="nav">${NAV.map(([k, label, icon]) => `<button data-tab="${k}">${icon}<span>${label}</span></button>`).join("")}</nav>
  </div>`;
  $("nav").querySelectorAll("button").forEach(b => b.onclick = () => go(b.dataset.tab));
  go("today");
  startGeneration();
}
function go(t){
  stopAll(); practice = null; tab = t;
  $("nav").querySelectorAll("button").forEach(b => b.classList.toggle("on", b.dataset.tab === t));
  const v = $("view"); v.className = "view"; v.scrollTop = 0;
  renderHeader();
  ({today:renderToday, talk:renderTalk, notebook:renderNotebook, plan:renderPlan, profile:renderProfile})[t]();
}
function renderHeader(){
  if(!$("abTitle")) return;
  const d = dayInfo();
  $("abEyebrow").textContent = d.bonus ? `Fluency mode · day ${d.n}` : `Day ${d.idx} of 30 · ${d.theme[2]}`;
  $("abTitle").textContent = d.bonus ? "Mixed topics" : d.theme[0];
  $("abStreak").textContent = streak();
  $("abToday").textContent = Object.keys(todayDone()).length;
  $("track").innerHTML = CURR.map((_, i) => `<i class="${!d.bonus && i+1 === d.idx ? "now" : (d.bonus || i+1 < d.idx) ? "done" : ""}"></i>`).join("");
}
window.onAndroidBack = () => {
  if(!user) return false;
  if(practice || tab !== "today"){ go("today"); return true; }
  return false;
};
window.onAppPause = () => { if(user) stopAll(); };
window.onAppResume = () => { if(user && lastDate !== today()){ lastDate = today(); go(tab); startGeneration(); } };
document.addEventListener("visibilitychange", () => { if(NATIVE) return; if(document.hidden) window.onAppPause(); else window.onAppResume(); });
document.addEventListener("focusin", e => { if(e.target.matches("textarea, .typerow input")) document.body.classList.add("typing"); });
document.addEventListener("focusout", () => setTimeout(() => { if(!document.activeElement || !document.activeElement.matches("textarea, .typerow input")) document.body.classList.remove("typing"); }, 50));

/* ================= daily conversations ================= */
function fill(str, r, picks){
  return str.replace(/\{(\w+?)(\d?)\}/g, (m, key, n) => {
    const k = key + n; if(picks[k]) return picks[k];
    const arr = F[key] || [key]; let v, tries = 0;
    do { v = arr[Math.floor(r()*arr.length)]; } while(Object.values(picks).includes(v) && ++tries < 8);
    return picks[k] = v;
  });
}
function builtInSet(date, d){
  const r = rng(date + ":" + d.n), theme = d.idx - 1;
  let order = [];
  if(d.bonus) order = [...Array(30).keys()].sort(() => r() - .5);
  else {
    for(let i = 0; i < 6; i++) order.push(theme);
    [...Array(theme).keys()].sort(() => r() - .5).forEach(i => order.push(i));
    [1,2,3,4].map(k => theme + k).filter(i => i < 30).forEach(i => order.push(i));
  }
  const out = []; let k = 0;
  while(out.length < 50){
    const idx = order[k % order.length], tpl = T[idx]; k++;
    const picks = {};
    const lines = tpl[2].map((t, i) => ({s: i % 2 === 0 ? "A" : "B", t: fill(t, r, picks)}));
    out.push({id:"b"+out.length, title: fill(tpl[0], r, picks), situation: fill(tpl[1], r, picks), partner: F.name[Math.floor(r()*F.name.length)], lines, review: !d.bonus && idx !== theme});
  }
  return out;
}
const setKey = () => "set:" + today() + ":" + dayInfo().n;
function todaysSet(){
  const base = builtInSet(today(), dayInfo()), ai = U.get(setKey(), []), done = todayDone();
  return base.map((c, i) => (!(c.id in done) && ai[i] && ai[i].lines) ? ai[i] : c);
}
const Gen = {running:false, error:null};
async function startGeneration(){
  if(Gen.running || !user || !S().apiKey) return;
  const key = setKey(), uid = user.id, d = dayInfo();
  const store = U.get(key, []);
  if(store.filter(Boolean).length >= 50) return;
  Gen.running = true; Gen.error = null; refreshGenBanner();
  const prev = CURR.slice(0, d.idx - 1).map(c => c[0]);
  for(let b = 0; b < 5; b++){
    if(store.slice(b*10, b*10+10).filter(Boolean).length >= 10) continue;
    if(!user || user.id !== uid || setKey() !== key) break;
    const review = d.bonus || (b >= 3 && prev.length > 0);
    const topic = d.bonus ? "Mixed review of: " + CURR.map(c => c[0]).sort(() => Math.random() - .5).slice(0, 6).join("; ")
      : review ? "Review of earlier topics: " + prev.slice(-8).join("; ") : d.theme[0];
    const have = store.filter(Boolean).map(c => c.title).join("; ");
    const prompt = `You write short spoken-English practice dialogues for ${user.name}, an Indian adult learner (self-rated level: ${user.level || "Beginner"}) on Day ${Math.min(d.n, 30)} of a 30-day course (target CEFR ${d.theme[2]}).
Date: ${today()}. Batch ${b+1} of 5. Topic: ${topic}. Grammar focus: ${d.theme[1]}.
Write 10 DIFFERENT realistic everyday conversations with varied settings in India and abroad and varied people. ${have ? "Already written today (don't repeat these situations): " + have + "." : ""}
Each has 6 or 8 lines alternating speaker "A" (the partner) and "B" (the learner), starting with A. The partner may call the learner by first name. Keep B's lines at ${d.theme[2]} level: natural, spoken, 6 to 18 words, and use the grammar focus where it fits.
Reply with ONLY a JSON array of 10 objects: {"title": "3-5 words", "situation": "one short sentence", "partner": "first name of A", "lines": [{"s":"A","t":"..."},{"s":"B","t":"..."}]}`;
    try{
      const arr = await claudeJSON({messages:[{role:"user", content:prompt}], maxTokens:6000});
      if(!Array.isArray(arr)) throw {code:"json"};
      if(!user || user.id !== uid) break;
      arr.slice(0, 10).forEach((c, i) => {
        if(!c || !Array.isArray(c.lines)) return;
        const lines = c.lines.filter(l => l && l.t).map(l => ({s: l.s === "B" ? "B" : "A", t: String(l.t)}));
        if(lines.length < 2 || !lines.some(l => l.s === "B")) return;
        store[b*10 + i] = {id:"a"+(b*10+i), title:String(c.title || "Conversation"), situation:String(c.situation || ""), partner:String(c.partner || "Alex"), lines, review, ai:true};
      });
      U.set(key, store);
      if(tab === "today" && !practice){ const v = $("view"), y = v.scrollTop; renderToday(); v.scrollTop = y; }
    }catch(e){ Gen.error = e; break; }
  }
  Gen.running = false; refreshGenBanner();
}
function refreshGenBanner(){
  const b = $("genBanner"); if(!b) return;
  const n = U.get(setKey(), []).filter(Boolean).length;
  b.className = "banner"; b.hidden = false;
  if(!S().apiKey){ b.innerHTML = `<span style="flex:1">You’re on the built-in course. Add your Claude API key to get 50 brand-new AI conversations every day and detailed corrections.</span><button class="btn small" id="gbKey">Add key</button>`; $("gbKey").onclick = () => go("profile"); return; }
  if(Gen.running){ b.innerHTML = `<span>Writing today’s fresh conversations · <b class="num">${n}/50</b></span><span class="bar"><i style="width:${n*2}%"></i></span>`; return; }
  if(Gen.error && n < 50){ b.className = "banner warn"; b.innerHTML = `<span style="flex:1">${esc(apiErrorText(Gen.error))} ${n}/50 fresh conversations ready.</span><button class="btn small" id="gbRetry">Retry</button>`; $("gbRetry").onclick = startGeneration; return; }
  if(n >= 50){ b.innerHTML = `<span>Today’s 50 fresh AI conversations are ready. Tomorrow you get 50 new ones.</span>`; return; }
  b.hidden = true;
}

/* ================= Today ================= */
function renderToday(){
  practice = null; renderHeader();
  const d = dayInfo(), set = todaysSet(), done = todayDone(), n = Object.keys(done).length, goal = S().goal;
  const next = set.findIndex(c => !(c.id in done));
  const welcome = !U.get("welcomed", false);
  const row = (c, i) => `<button class="item${c.id in done ? " done" : ""}" data-i="${i}"><span class="n">${String(i+1).padStart(2, "0")}</span><span class="t">${esc(c.title)}${c.ai ? `<span class="ai">AI</span>` : ""}<span class="s">${esc(c.situation)}</span></span><span class="st">${c.id in done ? done[c.id] + "/10" : c.lines.filter(l => l.s === "B").length + " turns"}</span></button>`;
  const main = [], rev = [];
  set.forEach((c, i) => (c.review ? rev : main).push(row(c, i)));
  $("view").innerHTML = `<div class="stack">
    ${welcome ? `<div class="card welcome"><h2 style="font-size:20px">Welcome, ${esc(user.name.split(" ")[0])}</h2>
      <ol><li>Each conversation: listen to your partner, then <b>speak your reply</b>. You’re corrected instantly.</li><li>Use <b>Talk</b> for a free voice chat with your tutor.</li><li>Every mistake is saved in <b>Mistakes</b> so you can practise it again.</li></ol>
      <div class="row2"><button class="btn primary small" id="wMic">Allow microphone</button><button class="btn small" id="wKey">Add AI key</button><span class="grow"></span><button class="btn ghost small" id="wDone">Got it</button></div></div>` : ""}
    <div class="card hero"><div class="label">${new Date().toLocaleDateString("en-IN", {weekday:"long", day:"numeric", month:"long"})}</div>
      <h2>${n >= goal ? "Goal reached. Keep going!" : n ? `${goal - n} more to reach today’s goal` : `Hi ${esc(user.name.split(" ")[0])}, ready to speak?`}</h2>
      <div class="row2"><span class="chip">CEFR ${d.theme[2]}</span><span class="muted" style="font-size:13.5px">Grammar: ${esc(d.theme[1])}</span></div>
      <div class="bar"><i style="width:${Math.min(100, n*2)}%"></i></div>
      <div class="row2"><span class="muted num" style="font-size:13.5px">${n} of 50 done · goal ${goal}</span><span class="grow"></span>${next >= 0 ? `<button class="btn primary" id="startNext">${n ? "Next conversation" : "Start speaking"}</button>` : ""}</div></div>
    <div class="banner" id="genBanner" hidden></div>
    <section class="group"><h2>${esc(d.bonus ? "Today’s mix" : d.theme[0])}</h2><div class="list">${main.join("")}</div></section>
    ${rev.length ? `<section class="group"><h2>Review and preview</h2><p class="muted" style="font-size:13.5px">Earlier topics so nothing fades, plus a taste of what’s next.</p><div class="list">${rev.join("")}</div></section>` : ""}
  </div>`;
  refreshGenBanner();
  $("view").querySelectorAll(".item").forEach(b => b.onclick = () => openPractice(+b.dataset.i));
  if($("startNext")) $("startNext").onclick = () => openPractice(next);
  if(welcome){
    $("wMic").onclick = async () => { const ok = await Speech.ensureMic(); toast(ok ? "Microphone allowed" : "Microphone is still off"); };
    $("wKey").onclick = () => go("profile");
    $("wDone").onclick = () => { U.set("welcomed", true); renderToday(); };
  }
}

/* ================= shared chat pieces ================= */
function bubble(thread, who, text, you){
  const el = document.createElement("div"); el.className = "msg " + (you ? "you" : "them");
  el.innerHTML = `<div class="who">${esc(who)}${you ? "" : `<button class="icon-btn" aria-label="Listen again">${I.speaker}</button>`}</div><div class="bubble">${esc(text)}</div>`;
  const s = el.querySelector(".icon-btn"); if(s) s.onclick = () => Voice.speak(text);
  thread.appendChild(el); scrollDown(thread); return el;
}
function sysNote(thread, text){ const el = document.createElement("div"); el.className = "sys"; el.textContent = text; thread.appendChild(el); scrollDown(thread); return el; }
function scrollDown(el){ requestAnimationFrame(() => { el.scrollTop = el.scrollHeight; }); }
function fixCard(thread, r, conf){
  const el = document.createElement("div"); el.className = "fix " + (r.ok ? "good" : "warn");
  const target = r.natural && r.natural.trim() ? r.natural : r.corrected;
  const list = r.mistakes.map(m => `<li><s>${esc(m.wrong)}</s> → <span class="right">${esc(m.right)}</span>${m.why ? ` <span class="why">· ${esc(m.why)}</span>` : ""}</li>`).join("");
  const showNat = r.natural && words(r.natural).join(" ") !== words(r.corrected).join(" ");
  el.innerHTML = `<div class="head"><span>${r.ok ? esc(r.praise || "Correct!") : r.mistakes.length + (r.mistakes.length > 1 ? " things" : " thing") + " to fix"}</span><span class="num">${r.score}/10</span></div>
    ${r.ok ? "" : `<ul>${list}</ul><div class="corr">Say: ${esc(r.corrected)}</div>`}
    ${showNat ? `<div class="nat"><b>${r.ai ? "Sounds natural" : "Model answer"}:</b> ${esc(r.natural)}</div>` : ""}
    ${conf >= 0 && conf < 0.5 ? `<div class="nat">I wasn’t fully sure what I heard. Speak a little slower and stress each word.</div>` : ""}
    ${target ? `<div class="acts"><button class="btn small" data-a="listen">${I.speaker} Listen</button><button class="btn small" data-a="drill">${I.mic} Say it again</button></div><div class="drill" hidden></div>` : ""}`;
  if(target){
    el.querySelector('[data-a="listen"]').onclick = () => Voice.speak(target);
    const btn = el.querySelector('[data-a="drill"]'); btn.onclick = () => drill(target, el.querySelector(".drill"), btn);
  }
  thread.appendChild(el); scrollDown(thread); return el;
}
function setMic(btn, state, level){
  btn.className = "bigmic " + state;
  btn.innerHTML = state === "speaking" ? I.stop : state === "thinking" ? I.spin : state === "listening" ? I.stop : I.mic;
  btn.setAttribute("aria-label", {idle:"Start speaking", listening:"Stop and send", speaking:"Stop voice and speak", thinking:"Checking"}[state] || "Mic");
  btn.style.setProperty("--lvl", state === "listening" ? String(1 + Math.min(0.35, Math.max(0, (level || 0)) / 30)) : "1");
}

/* ================= Practice (one of the 50) ================= */
function openPractice(i){
  stopAll();
  const set = todaysSet(), c = set[i]; if(!c) return;
  const p = practice = {c, i, step:0, scores:[], history:[], state:"idle", pendingSay:[]};
  const partner = c.partner || "Partner", tok = screenToken;
  const v = $("view"); v.className = "view fill";
  v.innerHTML = `<div class="room">
    <div class="room-head"><button class="icon-btn" id="pBack" aria-label="Back">${I.back}</button><div class="grow"><h2>${esc(c.title)}</h2><div class="scene">${esc(c.situation)} You’re talking with ${esc(partner)}.</div></div><span class="chip num">${i+1}/50</span></div>
    <div class="thread" id="thread"></div>
    <div class="dock" id="dock">
      <div class="live" id="live">Listen to ${esc(partner)}…</div>
      <div class="hint" id="hintBox" hidden></div>
      <div class="microw"><div class="side"><button class="btn small" id="pHint">Model reply</button></div><button class="bigmic" id="pMic"></button><div class="side r"><label class="toggle"><input type="checkbox" id="pHands" ${S().handsFree ? "checked" : ""}>Hands-free</label></div></div>
      <form class="typerow" id="pType"><input class="input" id="pInput" placeholder="Or type your reply" autocomplete="off"><button class="btn primary" aria-label="Send">${I.send}</button></form>
    </div></div>`;
  const thread = $("thread"), mic = $("pMic"), live = $("live");
  setMic(mic, "idle");
  $("pBack").onclick = () => go("today");
  $("pHands").onchange = e => setS({handsFree: e.target.checked});
  onStopAll = () => { if(practice === p && p.state !== "done"){ p.state = "idle"; setMic(mic, "idle"); live.textContent = "Paused. Tap the mic to continue."; live.classList.remove("on"); } };
  const alive = () => tok === screenToken && practice === p;
  const model = () => p.step < c.lines.length ? c.lines[p.step].t : "";

  function listen(){
    if(!alive()) return;
    p.state = "listening"; setMic(mic, "listening"); live.textContent = "Listening… speak now"; live.classList.add("on");
    Speech.start({
      onStart(){ if(alive()) live.textContent = "Listening… speak now"; },
      onLevel(l){ if(alive() && p.state === "listening") setMic(mic, "listening", l); },
      onPartial(t){ if(alive()) live.textContent = t; },
      onFinal(t, conf){ if(!alive()) return; if(!t.trim()){ idle(speechErrorText(7)); return; } submit(t, conf); },
      onError(code){ if(alive()) idle(speechErrorText(code)); }
    });
  }
  function idle(msg){ p.state = "idle"; setMic(mic, "idle"); live.textContent = msg || "Tap the mic and say your reply"; live.classList.toggle("on", !!msg); }
  function partnerTurn(){
    const say = p.pendingSay.splice(0);
    while(p.step < c.lines.length && c.lines[p.step].s === "A"){
      const t = c.lines[p.step].t; bubble(thread, partner, t, false); p.history.push(partner + ": " + t); say.push(t); p.step++;
    }
    if(p.step >= c.lines.length){ finish(say); return; }
    $("hintBox").hidden = true; $("hintBox").innerHTML = `<b>Model</b>${esc(model())}`; $("pHint").hidden = false;
    p.state = "speaking"; setMic(mic, "speaking"); live.textContent = `${partner} is speaking…`; live.classList.remove("on");
    Voice.speakSeq(say, () => { if(!alive()) return; if(S().handsFree) listen(); else idle(); });
  }
  async function submit(text, conf){
    if(!alive() || p.state === "thinking") return;
    Speech.stop();
    bubble(thread, "You", text, true);
    p.state = "thinking"; setMic(mic, "thinking"); live.textContent = "Checking your English…"; live.classList.remove("on");
    const partnerLine = p.history.length ? p.history[p.history.length-1].replace(/^[^:]+:\s*/, "") : "";
    const r = await checkReply(text, {situation:c.situation, history:p.history.slice(-6).join("\n"), partnerLine, model:model()});
    if(!alive()) return;
    fixCard(thread, r, conf);
    if(r.mistakes.length) logMistakes(r.mistakes);
    if(r.mistakes.length && S().speakCorrections) p.pendingSay.push("Better: " + r.corrected);
    p.scores.push(r.score); p.history.push("Learner: " + text); p.step++;
    partnerTurn();
  }
  function finish(say){
    const sc = p.scores.length ? Math.round(p.scores.reduce((a,b) => a+b, 0) / p.scores.length) : 10;
    markDone(c.id, sc); renderHeader();
    p.state = "done";
    const fresh = todaysSet(), done = todayDone(), n = Object.keys(done).length;
    const next = fresh.findIndex((x, k) => k !== i && !(x.id in done));
    $("dock").innerHTML = `<div class="summary stack" style="gap:8px"><div class="label">Conversation complete</div><h3>Score ${sc}/10</h3>
      <p class="muted">${n} of 50 done today. ${n >= S().goal ? "You’ve reached today’s goal." : (S().goal - n) + " more to reach today’s goal."} Read the whole conversation aloud once more, playing both parts.</p>
      <div class="row2">${next >= 0 ? `<button class="btn primary" id="pNext">Next conversation</button>` : ""}<button class="btn" id="pAgain">Try again</button><button class="btn ghost" id="pList">All 50</button></div></div>`;
    if(next >= 0) $("pNext").onclick = () => openPractice(next);
    $("pAgain").onclick = () => openPractice(i);
    $("pList").onclick = () => go("today");
    Voice.speakSeq([...say, `Well done. You scored ${sc} out of 10.`]);
  }
  mic.onclick = () => {
    if(p.state === "listening") Speech.finish();
    else if(p.state === "speaking"){ Voice.stop(); listen(); }
    else if(p.state === "idle") listen();
  };
  $("pHint").onclick = () => { $("hintBox").hidden = false; $("pHint").hidden = true; Voice.speak(model()); };
  $("pType").onsubmit = e => { e.preventDefault(); const t = $("pInput").value.trim(); if(!t || p.state === "thinking" || p.state === "done") return; $("pInput").value = ""; Voice.stop(); submit(t, -1); };
  partnerTurn();
}

/* ================= Talk (free voice tutor) ================= */
const TALK_MODES = [
  ["today","Today’s topic"],["free","Free talk"],["interview","Job interview"],["travel","Travel"],["office","Office chat"],["debate","Friendly debate"]
];
const talk = {mode:"today", msgs:[], noticed:false};
function talkOpener(mode){
  const first = user.name.split(" ")[0], d = dayInfo();
  return ({
    today: `Hi ${first}! Today’s topic is ${d.bonus ? "anything you like" : d.theme[0].toLowerCase()}. ${OPENERS[(d.idx-1) % OPENERS.length]}`,
    free: `Hi ${first}! How has your day been so far?`,
    interview: `Good morning, ${first}. Thanks for coming in today. Could you start by telling me a little about yourself?`,
    travel: `Good evening, and welcome to the Grand Palace Hotel. Do you have a reservation with us?`,
    office: `Hey ${first}! You look busy today. What are you working on?`,
    debate: `Here’s today’s question: is it better to live in a big city or a small town? What do you think, and why?`
  })[mode];
}
function tutorSystem(){
  const d = dayInfo();
  const modeLine = ({
    today: `Talk about today's topic: ${d.bonus ? "any everyday topic" : d.theme[0]}.`,
    free: "Talk about anything the learner likes and follow their lead.",
    interview: "Role-play: you are a friendly HR interviewer at a company in India interviewing them for a job in their field. Ask one interview question at a time and react like a real interviewer.",
    travel: "Role-play travel situations such as a hotel reception, airport check-in or asking a local for directions abroad. You play the staff member or local.",
    office: "Role-play a friendly colleague chatting at the office about meetings, deadlines and weekend plans.",
    debate: "Have a friendly debate. Politely take the opposite view and ask them to defend theirs."
  })[talk.mode];
  return `You are Maya, a warm, patient English speaking coach on a voice call with ${user.name}, an Indian learner. Their self-rated level is ${user.level || "Beginner"}; course day ${Math.min(d.n, 30)} of 30, target CEFR ${d.theme[2]}. ${modeLine}
The learner's words come from speech recognition, so ignore punctuation, capitalisation and spelling, and never correct those. If a word looks like a recognition error rather than a grammar error, don't count it.
For the learner's LATEST message:
1. Find real mistakes: grammar, tense, articles, prepositions, word order, wrong word, and Indian-English habits that confuse international listeners (e.g. "I am agree", "discuss about", "since 2 years"). Max 3, most important first. Empty list if it's fine.
2. Write your reply: 1 to 3 short spoken sentences at the learner's level. React to what they said, then ask one question to keep them talking. No lists, emojis or markdown. Use this grammar naturally when it fits: ${d.theme[1]}.
Respond with ONLY this JSON: {"mistakes":[{"wrong":"exact words","right":"fix","why":"one short simple sentence"}],"corrected":"their message with minimal fixes","natural":"how a fluent speaker would say it","score":0-10,"praise":"max 6 words","reply":"your spoken reply"}`;
}
async function tutorTurn(text){
  if(S().apiKey){
    try{
      const msgs = [{role:"user", content:"(The call has started. Greet me.)"}];
      talk.msgs.slice(-16).forEach(m => msgs.push({role: m.role === "tutor" ? "assistant" : "user", content: m.text}));
      const merged = [];
      msgs.forEach(m => { const last = merged[merged.length-1]; if(last && last.role === m.role) last.content += "\n" + m.content; else merged.push({role:m.role, content:m.content}); });
      const raw = await claude({system: tutorSystem(), messages: merged, maxTokens: 900});
      let r; try{ r = parseJSON(raw); }catch(e){ r = {reply: raw, mistakes: []}; }
      if(typeof r !== "object" || !r) r = {reply: String(raw)};
      return {fix: normalizeFix(r, text, ""), reply: String(r.reply || "That’s interesting. Can you tell me more?")};
    }catch(e){ lastAiError = e; }
  }
  const fix = localCheck(text, ""); fix.natural = "";
  return {fix, reply: OFFLINE_REPLIES[talk.msgs.length % OFFLINE_REPLIES.length], offline:true};
}
function renderTalk(){
  const v = $("view"); v.className = "view fill";
  v.innerHTML = `<div class="room">
    <div class="modes" id="modes">${TALK_MODES.map(([k, l]) => `<button data-m="${k}" class="${talk.mode === k ? "on" : ""}">${l}</button>`).join("")}</div>
    <div class="thread" id="thread"></div>
    <div class="dock">
      <div class="live" id="live">Tap the mic to start the call</div>
      <div class="microw"><div class="side"><button class="btn small" id="tNew">New chat</button></div><button class="bigmic" id="tMic"></button><div class="side r"><label class="toggle"><input type="checkbox" id="tHands" ${S().handsFree ? "checked" : ""}>Hands-free</label></div></div>
      <form class="typerow" id="tType"><input class="input" id="tInput" placeholder="Or type a message" autocomplete="off"><button class="btn primary" aria-label="Send">${I.send}</button></form>
    </div></div>`;
  const thread = $("thread"), mic = $("tMic"), live = $("live"), tok = screenToken;
  let state = "idle", retries = 0;
  const alive = () => tok === screenToken && tab === "talk";
  setMic(mic, "idle");
  if(!S().apiKey) sysNote(thread, "Basic mode: the built-in checker corrects common mistakes. Add your Claude API key in Profile for a real conversation partner.");
  talk.msgs.forEach(m => { if(m.role === "tutor") bubble(thread, "Maya", m.text, false); else { bubble(thread, "You", m.text, true); if(m.fix) fixCard(thread, m.fix, -1); } });
  onStopAll = () => { if(tab === "talk"){ state = "idle"; setMic(mic, "idle"); live.textContent = "Paused. Tap the mic to continue."; live.classList.remove("on"); } };

  function idle(msg){ state = "idle"; setMic(mic, "idle"); live.textContent = msg || "Tap the mic and speak"; live.classList.toggle("on", !!msg); }
  function speakThen(parts){
    state = "speaking"; setMic(mic, "speaking"); live.textContent = "Maya is speaking… tap to interrupt"; live.classList.remove("on");
    Voice.speakSeq(parts, () => { if(!alive()) return; if(S().handsFree){ retries = 0; listen(); } else idle(); });
  }
  function listen(){
    if(!alive()) return;
    state = "listening"; setMic(mic, "listening"); live.textContent = "Listening… speak now"; live.classList.add("on");
    Speech.start({
      onLevel(l){ if(alive() && state === "listening") setMic(mic, "listening", l); },
      onPartial(t){ if(alive()) live.textContent = t; },
      onFinal(t, conf){ if(!alive()) return; if(!t.trim()){ idle(speechErrorText(7)); return; } handle(t, conf); },
      onError(code){
        if(!alive()) return;
        if((code === 6 || code === 7) && S().handsFree && retries < 1){ retries++; listen(); return; }
        idle(speechErrorText(code));
      }
    });
  }
  function start(){
    if(!talk.msgs.length){ const t = talkOpener(talk.mode); talk.msgs.push({role:"tutor", text:t}); bubble(thread, "Maya", t, false); speakThen([t]); }
    else listen();
  }
  async function handle(text, conf){
    if(state === "thinking") return;
    Speech.stop();
    const entry = {role:"you", text}; talk.msgs.push(entry); bubble(thread, "You", text, true);
    state = "thinking"; setMic(mic, "thinking"); live.textContent = "Maya is thinking…"; live.classList.remove("on");
    const r = await tutorTurn(text);
    if(!alive()) return;
    if(r.offline && S().apiKey && !talk.noticed){ talk.noticed = true; sysNote(thread, apiErrorText(lastAiError) + " Using the built-in checker."); }
    entry.fix = r.fix; fixCard(thread, r.fix, conf);
    if(r.fix.mistakes.length) logMistakes(r.fix.mistakes);
    talk.msgs.push({role:"tutor", text:r.reply}); bubble(thread, "Maya", r.reply, false);
    speakThen([(r.fix.mistakes.length && S().speakCorrections) ? "Small correction. You can say: " + r.fix.corrected : "", r.reply]);
  }
  mic.onclick = () => {
    if(state === "listening") Speech.finish();
    else if(state === "speaking"){ Voice.stop(); retries = 0; listen(); }
    else if(state === "idle"){ retries = 0; start(); }
  };
  $("tHands").onchange = e => setS({handsFree: e.target.checked});
  $("tNew").onclick = () => { stopAll(); talk.msgs = []; talk.noticed = false; renderTalk(); };
  $("modes").querySelectorAll("button").forEach(b => b.onclick = () => { stopAll(); talk.mode = b.dataset.m; talk.msgs = []; talk.noticed = false; renderTalk(); });
  $("tType").onsubmit = e => { e.preventDefault(); const t = $("tInput").value.trim(); if(!t || state === "thinking") return; $("tInput").value = ""; Voice.stop(); Speech.stop(); if(!talk.msgs.length){ const o = talkOpener(talk.mode); talk.msgs.push({role:"tutor", text:o}); bubble(thread, "Maya", o, false); } handle(t, -1); };
}

/* ================= Mistakes notebook ================= */
function renderNotebook(){
  const nb = U.get("notebook", []);
  if(!nb.length){ $("view").innerHTML = `<div class="stack"><h2 style="font-size:22px">Your mistakes</h2><div class="empty">No mistakes saved yet. Every correction from your conversations lands here so you can practise it again.</div></div>`; return; }
  const counts = {}; nb.forEach(m => { const k = m.wrong.toLowerCase() + " → " + m.right; counts[k] = (counts[k] || 0) + 1; });
  const top = Object.entries(counts).filter(([, n]) => n > 1).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const weekAgo = localDate(new Date(Date.now() - 6*86400000)), thisWeek = nb.filter(m => m.date >= weekAgo).length;
  $("view").innerHTML = `<div class="stack">
    <div><h2 style="font-size:22px">Your mistakes</h2><p class="muted num" style="font-size:13.5px">${nb.length} saved · ${thisWeek} in the last 7 days</p></div>
    ${top.length ? `<div class="banner warn" style="flex-direction:column;align-items:flex-start;gap:4px"><b>You repeat these</b>${top.map(([k, n]) => `<span>${esc(k)} <span class="num muted">×${n}</span></span>`).join("")}</div>` : ""}
    <div class="stack" style="gap:8px">${nb.slice(0, 150).map((m, i) => `<div class="nbi"><div class="pair"><s>${esc(m.wrong)}</s><span>→</span><span class="r">${esc(m.right)}</span></div>${m.why ? `<div>${esc(m.why)}</div>` : ""}
      <div class="meta"><span class="num">Day ${m.day} · ${esc(m.date)}</span><span><button class="btn ghost small" data-l="${i}">${I.speaker} Listen</button><button class="btn ghost small" data-d="${i}">${I.mic} Practise</button></span></div><div class="drill" id="dr${i}" hidden></div></div>`).join("")}</div>
    <div class="confirm" id="clearRow"><button class="btn danger small" id="clearBtn">Clear all mistakes</button></div></div>`;
  $("view").querySelectorAll("[data-l]").forEach(b => b.onclick = () => Voice.speak(nb[+b.dataset.l].right));
  $("view").querySelectorAll("[data-d]").forEach(b => b.onclick = () => drill(nb[+b.dataset.d].right, $("dr" + b.dataset.d), b));
  $("clearBtn").onclick = () => {
    $("clearRow").innerHTML = `<span>Delete all ${nb.length} saved mistakes?</span><button class="btn danger small" id="cYes">Delete</button><button class="btn ghost small" id="cNo">Keep them</button>`;
    $("cYes").onclick = () => { U.set("notebook", []); renderNotebook(); toast("Mistakes cleared"); };
    $("cNo").onclick = renderNotebook;
  };
}

/* ================= 30-day plan ================= */
function renderPlan(){
  const d = dayInfo(), done = U.get("done", {}), pr = U.get("practiced", []).slice().sort();
  const countFor = k => { const date = pr[k-1]; return date && done[date] ? Object.keys(done[date]).length : 0; };
  let html = "";
  PHASES.forEach(([a, b, name, desc]) => {
    html += `<div class="phase"><h2>${name}</h2><p class="muted" style="font-size:13.5px">${desc}</p></div>`;
    for(let k = a; k <= b; k++){
      const c = CURR[k-1], cls = !d.bonus && k === d.idx ? "now" : (d.bonus || k < d.idx) ? "past" : "", cnt = countFor(k);
      html += `<div class="pday ${cls}"><span class="d">${k}</span><div><div class="th">${esc(c[0])}</div><div class="fo">${esc(c[1])} · ${c[2]}</div></div><span class="cnt num">${cnt ? cnt + "/50" : k === d.idx && !d.bonus ? "Today" : ""}</span></div>`;
    }
  });
  $("view").innerHTML = `<div class="stack">
    <div class="card"><h2 style="font-size:22px">${d.bonus ? "Course complete" : "Day " + d.idx + " of 30"}</h2>
      <p class="muted">A new day unlocks each calendar day you practise, so a missed day never skips a lesson. Aim for ${S().goal} conversations a day plus five minutes of free talk.</p>
      <div class="row2 num" style="font-size:13.5px"><span class="chip">Average score ${avgScore()}</span><span class="chip mark">${streak()}-day streak</span><span class="chip">${pr.length} days practised</span></div></div>
    <div class="plan">${html}</div></div>`;
}

/* ================= Profile & settings ================= */
function renderProfile(){
  const s = S();
  const opt = (list, val) => list.map(([v, l]) => `<option value="${esc(v)}"${String(v) === String(val) ? " selected" : ""}>${esc(l)}</option>`).join("");
  $("view").innerHTML = `<div class="stack">
    <div class="card"><div class="row2"><div class="logo" style="width:46px;height:46px;border-radius:14px;font-family:var(--display);color:#fff;font-size:22px">${esc(user.name.trim()[0] || "?").toUpperCase()}</div><div class="grow" style="min-width:0"><h2 style="font-size:20px">${esc(user.name)}</h2><div class="muted" style="font-size:13.5px;overflow-wrap:anywhere">${esc(user.email)} · joined ${esc(user.created)}</div></div></div>
      <div class="row2 num" style="font-size:13.5px"><span class="chip">Level: ${esc(user.level || "Beginner")}</span><span class="chip mark">${streak()}-day streak</span><span class="chip">Avg ${avgScore()}/10</span></div></div>

    <div class="card"><h3 style="font-size:18px">AI coach</h3>
      <p class="muted" style="font-size:13.5px">Your Claude API key turns on 50 fresh AI conversations a day, the voice tutor and detailed corrections. It stays on this phone and is sent only to Anthropic. Get one at <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener">console.anthropic.com</a>; typical use costs a few rupees a day.</p>
      <div class="keyrow"><input class="input" id="sKey" type="password" placeholder="sk-ant-…" value="${esc(s.apiKey)}" autocomplete="off" spellcheck="false"><button class="btn small" id="sKeyShow">Show</button></div>
      <div class="row2"><button class="btn primary small" id="sKeySave">Save and test</button>${s.apiKey ? `<button class="btn ghost small" id="sKeyDel">Remove key</button>` : ""}<span id="sKeyMsg" style="font-size:13.5px"></span></div>
      <div class="setrow"><div>AI model<small>Haiku is quick and cheap; Sonnet explains more.</small></div><select class="input" id="sModel">${opt(MODELS, s.model)}</select></div></div>

    <div class="card"><h3 style="font-size:18px">Voice</h3><div class="set">
      <div class="setrow"><div>Accent<small>Used to hear you and to speak to you.</small></div><select class="input" id="sAccent">${opt([["en-IN","Indian English"],["en-US","American English"],["en-GB","British English"]], s.accent)}</select></div>
      <div class="setrow"><div>Speaking speed</div><select class="input" id="sRate">${opt([[0.75,"Slow"],[0.95,"Normal"],[1.1,"Fast"]], s.rate)}</select></div>
      <div class="setrow"><div>Hands-free conversation<small>The mic opens by itself after your partner speaks.</small></div><input type="checkbox" class="switch" id="sHands" ${s.handsFree ? "checked" : ""}></div>
      <div class="setrow"><div>Say corrections out loud<small>Hear the corrected sentence before the conversation continues.</small></div><input type="checkbox" class="switch" id="sSpeakFix" ${s.speakCorrections ? "checked" : ""}></div>
      <div class="setrow"><div>Test<small>Hear the voice and check the microphone.</small></div><span class="row2"><button class="btn small" id="sTestVoice">${I.speaker} Voice</button><button class="btn small" id="sTestMic">${I.mic} Mic</button></span></div>
      <div class="drill" id="sMicOut" hidden></div></div></div>

    <div class="card"><h3 style="font-size:18px">Daily practice</h3><div class="set">
      <div class="setrow"><div>Daily goal</div><select class="input" id="sGoal">${opt([[10,"10 conversations"],[25,"25 conversations"],[50,"All 50"]], s.goal)}</select></div>
      <div class="setrow"><div>Daily reminder${NATIVE ? "" : "<small>Available in the Android app.</small>"}</div><span class="row2"><input type="time" class="input" id="sTime" value="${esc(s.reminderTime)}"><input type="checkbox" class="switch" id="sRemind" ${s.reminderOn ? "checked" : ""} ${NATIVE ? "" : "disabled"}></span></div></div></div>

    <div class="card"><h3 style="font-size:18px">Account</h3>
      <form class="form" id="pwForm" hidden><input class="input" type="password" id="pwOld" placeholder="Current password" autocomplete="current-password"><input class="input" type="password" id="pwNew" placeholder="New password (6+ characters)" autocomplete="new-password"><div class="err" id="pwErr"></div><div class="row2"><button class="btn primary small">Change password</button><button type="button" class="btn ghost small" id="pwCancel">Cancel</button></div></form>
      <div class="row2" id="accRow"><button class="btn small" id="pwShow">Change password</button><button class="btn small" id="logout">Log out</button><span class="grow"></span><button class="btn danger small" id="delAcc">Delete account</button></div></div>
    <p class="fine">SpeakUp 30 · version ${NATIVE ? esc(NATIVE.version ? NATIVE.version() : "1.0") : "web"}</p></div>`;

  $("sKeyShow").onclick = () => { const k = $("sKey"); k.type = k.type === "password" ? "text" : "password"; $("sKeyShow").textContent = k.type === "password" ? "Show" : "Hide"; };
  $("sKeySave").onclick = async () => {
    const k = $("sKey").value.trim(), msg = $("sKeyMsg");
    if(!k){ msg.className = "err"; msg.textContent = "Paste your key first."; return; }
    setS({apiKey: k}); msg.className = "muted"; msg.textContent = "Testing…";
    try{ await claude({messages:[{role:"user", content:"Reply with just the word OK."}], maxTokens:10}); msg.className = "okmsg"; msg.textContent = "Key works. AI coach is on."; Gen.error = null; startGeneration(); }
    catch(e){ msg.className = "err"; msg.textContent = apiErrorText(e); }
  };
  if($("sKeyDel")) $("sKeyDel").onclick = () => { setS({apiKey: ""}); renderProfile(); toast("Key removed"); };
  $("sModel").onchange = e => { setS({model: e.target.value}); Gen.error = null; };
  $("sAccent").onchange = e => setS({accent: e.target.value});
  $("sRate").onchange = e => setS({rate: Number(e.target.value)});
  $("sHands").onchange = e => setS({handsFree: e.target.checked});
  $("sSpeakFix").onchange = e => setS({speakCorrections: e.target.checked});
  $("sGoal").onchange = e => setS({goal: Number(e.target.value)});
  $("sTestVoice").onclick = () => Voice.speak(`Hello ${user.name.split(" ")[0]}! This is how I sound. Let's practise English together.`);
  $("sTestMic").onclick = () => drill("I want to speak English fluently", $("sMicOut"), $("sTestMic"));
  const saveReminder = () => {
    const on = $("sRemind").checked, time = $("sTime").value || "19:00";
    setS({reminderOn: on, reminderTime: time});
    if(NATIVE){ const [h, m] = time.split(":").map(Number); try{ NATIVE.setReminder(h, m, on); }catch(e){} }
    if(on) toast("Reminder set for " + time + " every day");
  };
  $("sRemind").onchange = saveReminder; $("sTime").onchange = () => { if($("sRemind").checked) saveReminder(); };
  $("pwShow").onclick = () => { $("pwForm").hidden = false; $("accRow").hidden = true; $("pwOld").focus(); };
  $("pwCancel").onclick = renderProfile;
  $("pwForm").onsubmit = async e => {
    e.preventDefault(); const err = $("pwErr"), nw = $("pwNew").value;
    if(nw.length < 6) return err.textContent = "Use at least 6 characters.";
    const acc = accounts(), k = keyOf(user.email), a = acc[k];
    if((await hashPw($("pwOld").value, a.salt)).hash !== a.hash) return err.textContent = "Your current password is incorrect.";
    Object.assign(a, await hashPw(nw)); Store.set("accounts", acc); user = a; renderProfile(); toast("Password changed");
  };
  $("logout").onclick = logOut;
  $("delAcc").onclick = () => {
    $("accRow").innerHTML = `<span style="flex:1">Delete your account and all progress on this phone? This can’t be undone.</span><button class="btn danger small" id="dYes">Delete</button><button class="btn ghost small" id="dNo">Cancel</button>`;
    $("dNo").onclick = renderProfile;
    $("dYes").onclick = () => {
      const acc = accounts(); delete acc[keyOf(user.email)]; Store.set("accounts", acc);
      try{ Object.keys(localStorage).filter(k => k.startsWith("u:" + user.id + ":")).forEach(k => localStorage.removeItem(k)); }catch(e){}
      stopAll(); Store.del("session"); user = null; renderAuth(Object.keys(acc).length ? "login" : "signup");
    };
  };
}

/* ================= boot ================= */
(function boot(){
  const k = Store.get("session", null), a = k && accounts()[k];
  if(a){ user = a; enterApp(); }
  else renderAuth(Object.keys(accounts()).length ? "login" : "signup");
})();
