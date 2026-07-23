/* JobApplier shared engine (validated). */



/* ════════════════════════════════════════════════════════════════════
   JobApplier — browser engine (ported from the Python core)
   JD parsing · ATS scoring · deterministic tailoring · pure-JS PDF · tracker
   ════════════════════════════════════════════════════════════════════ */

/* ── Lexicons (mirror of jobapplier/jd.py) ─────────────────────────── */
const KNOWN_SKILLS = new Set(["python","javascript","typescript","java","c++","c#","go","golang","rust","ruby","php","swift","kotlin","scala","r","matlab","sql","bash","shell","perl","objective-c","dart","elixir","haskell","react","react native","next.js","nextjs","vue","angular","svelte","node.js","nodejs","express","django","flask","fastapi","rails","spring","spring boot",".net","asp.net","laravel","graphql","rest","rest api","grpc","html","css","sass","tailwind","redux","machine learning","deep learning","nlp","computer vision","pandas","numpy","scikit-learn","tensorflow","pytorch","keras","spark","hadoop","kafka","airflow","dbt","snowflake","redshift","bigquery","tableau","power bi","looker","etl","data engineering","data science","llm","generative ai","rag","langchain","aws","azure","gcp","google cloud","docker","kubernetes","k8s","terraform","ansible","jenkins","ci/cd","cicd","github actions","gitlab","circleci","prometheus","grafana","datadog","helm","serverless","lambda","ec2","s3","microservices","linux","postgresql","postgres","mysql","mongodb","redis","elasticsearch","dynamodb","cassandra","sqlite","oracle","sql server","agile","scrum","kanban","tdd","devops","mlops","oop","distributed systems","system design","api design","unit testing","integration testing","object-oriented","functional programming","project management","product management","stakeholder management","budgeting","forecasting","excel","salesforce","sap","jira","confluence","figma","seo","sem","google analytics","a/b testing","customer success","account management","communication","leadership","cybersecurity","penetration testing","incident response","siem","soc","digital forensics","e-discovery","encryption","iso 27001","gdpr","hipaa","soc 2"]);
const STOPWORDS = new Set(["the","and","for","with","you","your","our","will","are","have","this","that","from","who","was","were","has","had","not","but","all","can","may","must","should","would","could","their","them","they","his","her","its","out","get","got","how","why","what","when","where","which","such","than","then","into","over","under","about","also","some","any","each","more","most","other","these","those","being","been","does","did","doing","here","there","a","an","in","on","of","to","as","at","by","or","is","be","it","we","us","if","so","do","up","no","yes","per","via","job","role","team","work","working","company","position","candidate","experience","years","year","ability","strong","excellent","good","including","etc","plus","preferred","required","must","responsibilities","requirements","qualifications","benefits","apply","using","help","join","looking","seeking","ideal","opportunity","environment","across","within","new","well","high","great","deep","hire","hiring","build","building"]);
const REQ_HEADERS = /(requirements|qualifications|what you.?ll need|must have|skills|we.?re looking for|about you|who you are|minimum)/i;
const WORD_RE = /[A-Za-z][A-Za-z0-9+.#/-]*/g;
const TITLE_HINTS = ["engineer","developer","manager","analyst","scientist","designer","architect","consultant","specialist","lead","director","administrator","coordinator","attorney","paralegal","accountant","nurse","technician"];

function escapeRe(s){ return s.replace(/[.*+?^${}()|[\]\\]/g,"\\$&"); }
function kwRegex(kw){ return new RegExp("(?<![A-Za-z0-9])"+escapeRe(kw)+"(?![A-Za-z0-9])","i"); }
function contains(hayLower, kw){ try{ return kwRegex(kw).test(hayLower); }catch(e){ return hayLower.includes(kw.toLowerCase()); } }

/* ── JD parsing ────────────────────────────────────────────────────── */
function parseJD(text, titleHint){
  text = text||""; const lower = text.toLowerCase();
  let reqRegion = "";
  const m = REQ_HEADERS.exec(text);
  if(m){ reqRegion = lower.slice(m.index, m.index+1500); }
  const weights = {};
  // 1) known skills
  for(const skill of KNOWN_SKILLS){
    let re; try{ re = new RegExp("(?<![A-Za-z0-9])"+escapeRe(skill)+"(?![A-Za-z0-9])","gi"); }catch(e){ continue; }
    const n = (lower.match(re)||[]).length;
    if(n){ let w = 3.0 + Math.min(n-1,3)*0.5; if(reqRegion.includes(skill)) w+=2.0; weights[skill]=w; }
  }
  // 2) salient generic words
  const tokens = (text.match(WORD_RE)||[]).map(t=>t.toLowerCase());
  const counts = {};
  for(const t of tokens){ if(!STOPWORDS.has(t) && t.length>2) counts[t]=(counts[t]||0)+1; }
  for(const word in counts){
    if(weights[word]!==undefined) continue;
    if(/^\d+$/.test(word)) continue;
    const freq = counts[word];
    let w = 1.0 + Math.min(freq-1,4)*0.4;
    if(reqRegion.includes(word)) w+=1.0;
    if(w>=1.4 || freq>=2) weights[word]=w;
  }
  // 3) title guess
  let titleGuess = (titleHint||"").trim();
  if(!titleGuess){
    for(const line of text.split(/\n/)){
      const ls = line.trim();
      if(ls.length>3 && ls.length<80 && TITLE_HINTS.some(h=>ls.toLowerCase().includes(h))){ titleGuess=ls; break; }
    }
  }
  return {titleGuess, keywords:weights, raw:text};
}
function topKeywords(jd, n){
  return Object.entries(jd.keywords).sort((a,b)=>b[1]-a[1]).slice(0,n||25).map(e=>e[0]);
}

/* ── Resume flatten + ATS scoring (mirror ats.py) ──────────────────── */
function resumeText(r){
  const parts=[r.name,r.title,r.summary,(r.skills||[]).join(" "),(r.certifications||[]).join(" "),(r.projects||[]).join(" ")];
  for(const e of (r.experience||[])) parts.push(e.title,e.company,(e.bullets||[]).join(" "));
  for(const ed of (r.education||[])) parts.push(ed.degree,ed.school,ed.details);
  if(r.raw) parts.push(r.raw);   // include original imported text so scoring never misses content
  return parts.filter(Boolean).join("\n");
}
function structureChecks(r){
  const issues=[]; let pts=0;
  if(r.email && /[^@\s]+@[^@\s]+\.[^@\s]+/.test(r.email)) pts+=2; else issues.push("Missing or malformed email");
  if(r.phone) pts+=1; else issues.push("Missing phone number");
  if((r.skills||[]).length) pts+=2; else issues.push("No Skills section");
  if((r.experience||[]).length) pts+=2; else issues.push("No work experience");
  if((r.education||[]).length) pts+=1; else issues.push("No education section");
  if((r.experience||[]).some(e=>(e.bullets||[]).length)) pts+=1; else issues.push("Experience has no bullets");
  if(r.summary) pts+=1; else issues.push("No professional summary");
  return {pts, issues};
}
function atsScore(r, jd){
  const t = resumeText(r).toLowerCase();
  let totalW=0; for(const k in jd.keywords) totalW+=jd.keywords[k]; totalW=totalW||1;
  let matchedW=0; const matched=[], missing=[];
  for(const kw in jd.keywords){
    if(contains(t,kw)){ matchedW+=jd.keywords[kw]; matched.push(kw); }
    else missing.push([kw,jd.keywords[kw]]);
  }
  const keywordScore = 100*matchedW/totalW;
  const {pts,issues} = structureChecks(r);
  const structureScore = 100*pts/10;
  const final = 0.82*keywordScore + 0.18*structureScore;
  missing.sort((a,b)=>b[1]-a[1]);
  matched.sort((a,b)=>(jd.keywords[b]||0)-(jd.keywords[a]||0));
  return {score:Math.round(final*10)/10, keywordScore:Math.round(keywordScore*10)/10,
    structureScore:Math.round(structureScore*10)/10, matched, missing, issues};
}
function grade(s){ return s>=85?"A":s>=70?"B":s>=55?"C":s>=40?"D":"F"; }

/* ── Deterministic tailoring (mirror tailor.py) ────────────────────── */
const SPECIALS = {"aws":"AWS","gcp":"GCP","sql":"SQL","nlp":"NLP","ci/cd":"CI/CD","cicd":"CI/CD","api":"API","rest":"REST","rest api":"REST APIs","graphql":"GraphQL","html":"HTML","css":"CSS","k8s":"Kubernetes","ml":"ML","llm":"LLMs","tdd":"TDD","oop":"OOP","etl":"ETL","seo":"SEO",".net":".NET","node.js":"Node.js","next.js":"Next.js","postgresql":"PostgreSQL","postgres":"Postgres","mysql":"MySQL","mongodb":"MongoDB","devops":"DevOps","mlops":"MLOps","gdpr":"GDPR","hipaa":"HIPAA","siem":"SIEM"};
function titleize(kw){ if(SPECIALS[kw]) return SPECIALS[kw]; return kw===kw.toLowerCase()? kw.replace(/\b\w/g,c=>c.toUpperCase()) : kw; }
function dedup(items){ const seen=new Set(), out=[]; for(const it of items){ const k=it.toLowerCase(); if(!seen.has(k)){ seen.add(k); out.push(it);} } return out; }

function tailor(resume, jd){
  const out = JSON.parse(JSON.stringify(resume));
  const tLower = resumeText(resume).toLowerCase();
  const topKw = topKeywords(jd,30);
  const jdKwLower = new Set(Object.keys(jd.keywords).map(k=>k.toLowerCase()));
  const have = {}; for(const s of (out.skills||[])) have[s.toLowerCase()]=s;
  const prioritized=[];
  for(const kw of topKw){ if(have[kw] && !prioritized.includes(have[kw])) prioritized.push(have[kw]); }
  for(const s of (out.skills||[])){ if(!prioritized.includes(s)) prioritized.push(s); }
  for(const kw of topKw){
    if(jdKwLower.has(kw) && !(kw in have)){
      if(KNOWN_SKILLS.has(kw) && contains(tLower,kw)){ const t=titleize(kw); prioritized.push(t); have[kw]=t; }
    }
  }
  out.skills = dedup(prioritized);
  // summary
  const owned=[]; for(const kw of topKw){ if(jdKwLower.has(kw) && ((kw in have)||contains(tLower,kw))) owned.push(titleize(kw)); }
  out.summary = buildSummary(resume, jd, owned.slice(0,6));
  // reorder bullets
  for(const exp of (out.experience||[])){
    exp.bullets = reorderBullets(exp.bullets||[], topKw);
  }
  return out;
}
function buildSummary(resume, jd, owned){
  const target = (jd.titleGuess||resume.title||"").trim();
  const base = (resume.summary||"").trim();
  let lead="";
  if(target && !base.slice(0,80).toLowerCase().includes(target.toLowerCase())) lead = target+" with a background aligned to this role. ";
  let kw = owned.length? " Core strengths: "+owned.join(", ")+"." : "";
  return (lead+base+kw).trim();
}
function reorderBullets(bullets, topKw){
  const rel = b => { const bl=b.toLowerCase(); let n=0; for(const kw of topKw) if(bl.includes(kw)) n++; return n; };
  return bullets.map((b,i)=>[b,i]).sort((a,b)=> (rel(b[0])-rel(a[0])) || (a[1]-b[1])).map(x=>x[0]);
}

/* ── Cover letter + screening (mirror apply.py) ────────────────────── */
function coverBlurb(resume, job, matched){
  const role = job.title || "this role";
  const company = job.company || "your team";
  const strengths = (matched.slice(0,5).length? matched.slice(0,5): (resume.skills||[]).slice(0,5)).join(", ");
  const name = resume.name || "I";
  return `Dear Hiring Team at ${company},\n\nI'm excited to apply for ${role}. My background in ${strengths} maps directly to what you're looking for. ${(resume.summary||"").trim()} I'd welcome the chance to bring this experience to ${company}.\n\nBest regards,\n${name}`;
}
const SCREEN_QS = ["Are you legally authorized to work in this location?","Will you now or in the future require sponsorship?","Notice period / earliest start date","Desired salary / compensation expectations","Years of experience with the primary required skill","How did you hear about this role?"];
function screenTemplate(){ return SCREEN_QS.map(q=>`${q}\n  - `).join("\n"); }

/* ── Filenames (mirror render.py) ──────────────────────────────────── */
function slugify(s,maxlen){ s=(s||"").trim().replace(/[^\w\s-]/g,"").replace(/[\s_]+/g,"-").replace(/^-+|-+$/g,""); return (s.slice(0,maxlen||60))||"untitled"; }
function jobBasename(job){
  const c = job.company? slugify(job.company):"";
  const role = job.title? slugify(job.title):"resume";
  const parts=[c,role].filter(Boolean);
  return parts.length? parts.join("_"):"resume";
}

/* ── Resume → text / preview ───────────────────────────────────────── */
function resumeToText(r){
  const L=[]; L.push(r.name||""); if(r.title) L.push(r.title);
  const contact=[r.email,r.phone,r.location,...(r.links||[])].filter(Boolean).join(" | ");
  if(contact) L.push(contact); L.push("");
  if(r.summary){ L.push("SUMMARY",r.summary,""); }
  if((r.skills||[]).length){ L.push("SKILLS",r.skills.join(", "),""); }
  if((r.experience||[]).length){ L.push("EXPERIENCE");
    for(const e of r.experience){ const head=[e.title,e.company,e.location].filter(Boolean).join(" | ");
      const dates=[e.start,e.end].filter(Boolean).join(" - "); L.push(head+(dates?`   (${dates})`:""));
      for(const b of (e.bullets||[])) L.push("  - "+b); L.push(""); } }
  if((r.projects||[]).length){ L.push("PROJECTS"); for(const p of r.projects) L.push("  - "+p); L.push(""); }
  if((r.education||[]).length){ L.push("EDUCATION");
    for(const ed of r.education){ L.push([ed.degree,ed.school,ed.location,ed.year].filter(Boolean).join(" | ")); if(ed.details) L.push("  "+ed.details);} L.push(""); }
  if((r.certifications||[]).length){ L.push("CERTIFICATIONS",r.certifications.join(", "),""); }
  return L.join("\n").replace(/\s+$/,"")+"\n";
}
function esc(s){ return (s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }
function renderPreview(r){
  const contact=[r.email,r.phone,r.location,...(r.links||[])].filter(Boolean).map(esc).join(" &nbsp;·&nbsp; ");
  let h=`<h3>${esc(r.name)}</h3>`;
  if(r.title) h+=`<div class="ptitle">${esc(r.title)}</div>`;
  h+=`<div class="pcontact">${contact}</div>`;
  if(r.summary) h+=`<div class="psec">Summary</div><div>${esc(r.summary)}</div>`;
  if((r.skills||[]).length) h+=`<div class="psec">Skills</div><div>${esc(r.skills.join(" · "))}</div>`;
  if((r.experience||[]).length){ h+=`<div class="psec">Experience</div>`;
    for(const e of r.experience){ const head=esc([e.title,e.company].filter(Boolean).join(" — "));
      const meta=esc([e.location,[e.start,e.end].filter(Boolean).join(" - ")].filter(Boolean).join(" | "));
      h+=`<div class="pexp">${head} <span class="pmeta">${meta}</span></div><ul>`;
      for(const b of (e.bullets||[])) h+=`<li>${esc(b)}</li>`; h+=`</ul>`; } }
  if((r.projects||[]).length){ h+=`<div class="psec">Projects</div><ul>`; for(const p of r.projects) h+=`<li>${esc(p)}</li>`; h+=`</ul>`; }
  if((r.education||[]).length){ h+=`<div class="psec">Education</div>`;
    for(const ed of r.education){ h+=`<div class="pexp">${esc([ed.degree,ed.school,ed.year].filter(Boolean).join(" — "))}</div>`; if(ed.details) h+=`<div class="pmeta">${esc(ed.details)}</div>`; } }
  if((r.certifications||[]).length) h+=`<div class="psec">Certifications</div><div>${esc(r.certifications.join(", "))}</div>`;
  return h;
}

/* ── Pure-JS PDF writer (port of pdfwriter.py) ─────────────────────── */
const HELV=[278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584];
const HELVB=[278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,611,611,389,556,333,611,556,778,556,556,500,389,280,389,584];
function charW(ch,bold){ const o=ch.charCodeAt(0); const t=bold?HELVB:HELV; return (o>=32&&o<=126)? t[o-32]:556; }
function textWidth(s,size,bold){ let w=0; for(const c of s) w+=charW(c,bold); return w*size/1000; }
function wrapText(s,size,maxW,bold){ const words=s.split(/\s+/).filter(Boolean); if(!words.length) return [""]; const lines=[]; let cur=words[0];
  for(let i=1;i<words.length;i++){ const trial=cur+" "+words[i]; if(textWidth(trial,size,bold)<=maxW) cur=trial; else { lines.push(cur); cur=words[i]; } } lines.push(cur); return lines; }
function pdfEsc(s){ return s.replace(/\\/g,"\\\\").replace(/\(/g,"\\(").replace(/\)/g,"\\)"); }
function toLatin1(s){ let o=""; for(const c of s){ o += c.charCodeAt(0)<256? c:"?"; } return o; }

function ResumePDF(){
  const PW=612, PH=792, M=54, CW=PW-2*M;
  let pages=[[]], y=PH-M;
  function newpage(){ pages.push([]); y=PH-M; }
  function ensure(h){ if(y-h<M) newpage(); }
  function emit(text,size,bold,x){ const f=bold?"F2":"F1"; pages[pages.length-1].push(`BT /${f} ${size.toFixed(1)} Tf 1 0 0 1 ${x.toFixed(1)} ${y.toFixed(1)} Tm (${pdfEsc(toLatin1(text))}) Tj ET`); }
  const api={};
  api.space=h=>{ y-=(h||6); };
  api.rule=g=>{ ensure(6); y-=3; pages[pages.length-1].push(`${(g||.75).toFixed(2)} G 0.6 w ${M} ${y.toFixed(1)} m ${(PW-M)} ${y.toFixed(1)} l S 0 G`); y-=5; };
  api.para=(text,size,bold,indent,gap)=>{ size=size||10; const lead=size*1.32; const x=M+(indent||0);
    for(const line of wrapText(text,size,CW-(indent||0),bold)){ ensure(lead); emit(line,size,bold,x); y-=lead; } y-=(gap===undefined?2:gap); };
  api.bullet=(text,size)=>{ size=size||10; const lead=size*1.32; const mi=12; let first=true;
    for(const line of wrapText(text,size,CW-mi,false)){ ensure(lead); if(first){ emit("-",size,false,M+2); first=false; } emit(line,size,false,M+mi); y-=lead; } y-=1.5; };
  api.heading=(text,size)=>{ size=size||11; api.space(4); ensure(size*1.4); emit(text.toUpperCase(),size,true,M); y-=size*1.25; api.rule(.6); };
  api.title=(name,lines)=>{ ensure(40); emit(name,18,true,M); y-=22; for(const cl of lines){ if(!cl) continue; emit(cl,9.5,false,M); y-=12; } y-=2; api.rule(.55); };
  api.build=()=>{
    const objs=[]; const add=o=>{ objs.push(o); return objs.length; };
    const f1=add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
    const f2=add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
    const contentNums=[];
    for(const ops of pages){ const stream=toLatin1(ops.join("\n")); contentNums.push(add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`)); }
    const pagesPlaceholder = objs.length + pages.length + 1;
    const pageNums=[];
    pages.forEach((_,i)=>{ pageNums.push(add(`<< /Type /Page /Parent ${pagesPlaceholder} 0 R /MediaBox [0 0 ${PW} ${PH}] /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >> >> /Contents ${contentNums[i]} 0 R >>`)); });
    const pagesNum = add(`<< /Type /Pages /Count ${pageNums.length} /Kids [${pageNums.map(n=>n+" 0 R").join(" ")}] >>`);
    const catalog = add(`<< /Type /Catalog /Pages ${pagesNum} 0 R >>`);
    let out="%PDF-1.4\n%âãÏÓ\n"; const offsets=[];
    objs.forEach((o,i)=>{ offsets.push(out.length); out += `${i+1} 0 obj\n${o}\nendobj\n`; });
    const xref=out.length; const n=objs.length;
    out += `xref\n0 ${n+1}\n0000000000 65535 f \n`;
    for(const off of offsets) out += String(off).padStart(10,"0")+" 00000 n \n";
    out += `trailer\n<< /Size ${n+1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    const bytes=new Uint8Array(out.length); for(let i=0;i<out.length;i++) bytes[i]=out.charCodeAt(i)&0xff;
    return bytes;
  };
  return api;
}
function buildResumePdfBytes(r){
  const pdf=ResumePDF();
  const contact=[[r.email,r.phone,r.location].filter(Boolean).join(" | ")];
  if((r.links||[]).length) contact.push(r.links.join(" | "));
  pdf.title(r.name||"Resume", contact.filter(Boolean));
  if(r.title) pdf.para(r.title,10.5,true,0,4);
  if(r.summary){ pdf.heading("Summary"); pdf.para(r.summary,10); }
  if((r.skills||[]).length){ pdf.heading("Skills"); pdf.para(r.skills.join(", "),10); }
  if((r.experience||[]).length){ pdf.heading("Experience");
    for(const e of r.experience){ const head=[e.title,e.company,e.location].filter(Boolean).join("  |  ");
      const dates=[e.start,e.end].filter(Boolean).join(" - "); pdf.para(head+(dates?`   (${dates})`:""),10.5,true,0,1);
      for(const b of (e.bullets||[])) pdf.bullet(b,10); pdf.space(3); } }
  if((r.projects||[]).length){ pdf.heading("Projects"); for(const p of r.projects) pdf.bullet(p,10); }
  if((r.education||[]).length){ pdf.heading("Education");
    for(const ed of r.education){ pdf.para([ed.degree,ed.school,ed.location,ed.year].filter(Boolean).join("  |  "),10.5,true,0,1); if(ed.details) pdf.para(ed.details,9.5,false,4); } }
  if((r.certifications||[]).length){ pdf.heading("Certifications"); pdf.para(r.certifications.join(", "),10); }
  return pdf.build();
}
function downloadBytes(bytes, filename, mime){
  const blob=new Blob([bytes],{type:mime||"application/octet-stream"});
  const url=URL.createObjectURL(blob); const a=document.createElement("a");
  a.href=url; a.download=filename; document.body.appendChild(a); a.click();
  setTimeout(()=>{ URL.revokeObjectURL(url); a.remove(); },100);
}

/* ════════════════════════════════════════════════════════════════════
   State + persistence
   ════════════════════════════════════════════════════════════════════ */

/* -- DEFLATE inflate (RFC 1951), growable output -- */
const _LB=[3,4,5,6,7,8,9,10,11,13,15,17,19,23,27,31,35,43,51,59,67,83,99,115,131,163,195,227,258];
const _LE=[0,0,0,0,0,0,0,0,1,1,1,1,2,2,2,2,3,3,3,3,4,4,4,4,5,5,5,5,0];
const _DB=[1,2,3,4,5,7,9,13,17,25,33,49,65,97,129,193,257,385,513,769,1025,1537,2049,3073,4097,6145,8193,12289,16385,24577];
const _DE=[0,0,0,0,1,1,2,2,3,3,4,4,5,5,6,6,7,7,8,8,9,9,10,10,11,11,12,12,13,13];
const _CLO=[16,17,18,0,8,7,9,6,10,5,11,4,12,3,13,2,14,1,15];
function _tree(lens,n){const c=new Array(16).fill(0);for(let i=0;i<n;i++)c[lens[i]]++;c[0]=0;
  const o=new Array(16).fill(0);for(let i=1;i<16;i++)o[i]=o[i-1]+c[i-1];const sy=new Array(n);
  for(let s=0;s<n;s++)if(lens[s])sy[o[lens[s]]++]=s;return{c,sy};}
function inflateRaw(input,start){
  let pos=(start||0)<<3;
  const gb=()=>{const b=(input[pos>>3]>>(pos&7))&1;pos++;return b;};
  const gbs=k=>{let v=0;for(let i=0;i<k;i++)v|=gb()<<i;return v;};
  const dec=t=>{let code=0,first=0,index=0;for(let len=1;len<=15;len++){code|=gb();const cnt=t.c[len];
    if(code-first<cnt)return t.sy[index+(code-first)];index+=cnt;first+=cnt;first<<=1;code<<=1;}throw new Error("huffman");};
  const fl=new Array(288);for(let i=0;i<144;i++)fl[i]=8;for(let i=144;i<256;i++)fl[i]=9;for(let i=256;i<280;i++)fl[i]=7;for(let i=280;i<288;i++)fl[i]=8;
  const fLt=_tree(fl,288),fDt=_tree(new Array(30).fill(5),30);
  const out=[];let last;
  do{ last=gb();const type=gbs(2);
    if(type===0){pos=(pos+7)&~7;let p=pos>>3;const len=input[p]|(input[p+1]<<8);p+=4;for(let i=0;i<len;i++)out.push(input[p++]);pos=p<<3;}
    else{let lt,dt;
      if(type===1){lt=fLt;dt=fDt;}
      else if(type===2){const hlit=gbs(5)+257,hdist=gbs(5)+1,hclen=gbs(4)+4;const cl=new Array(19).fill(0);
        for(let i=0;i<hclen;i++)cl[_CLO[i]]=gbs(3);const clt=_tree(cl,19);const L=new Array(hlit+hdist).fill(0);let n=0;
        while(n<hlit+hdist){const s=dec(clt);if(s<16)L[n++]=s;else if(s===16){let r=gbs(2)+3;const pv=L[n-1];while(r--)L[n++]=pv;}
          else if(s===17){let r=gbs(3)+3;while(r--)L[n++]=0;}else{let r=gbs(7)+11;while(r--)L[n++]=0;}}
        lt=_tree(L.slice(0,hlit),hlit);dt=_tree(L.slice(hlit),hdist);}
      else throw new Error("btype");
      for(;;){const s=dec(lt);if(s===256)break;if(s<256)out.push(s);
        else{const e=s-257;const length=_LB[e]+gbs(_LE[e]);const ds=dec(dt);const dist=_DB[ds]+gbs(_DE[ds]);
          let from=out.length-dist;for(let i=0;i<length;i++)out.push(out[from+i]);}}}
  }while(!last);
  return new Uint8Array(out);
}
function zInflate(b){ if(b.length>2&&(b[0]&0x0f)===8&&(((b[0]<<8|b[1])%31)===0))return inflateRaw(b,2); return inflateRaw(b,0); }

/* -- PDF text extraction -- */
function _l1(b){let s="";const C=8192;for(let i=0;i<b.length;i+=C)s+=String.fromCharCode.apply(null,b.subarray(i,i+C));return s;}
function _pdfStr(s){let o="";for(let i=0;i<s.length;i++){const c=s[i];
  if(c==="\\"){const n=s[i+1];
    if(n==="n"){o+="\n";i++;}else if(n==="r"){o+="\r";i++;}else if(n==="t"){o+="\t";i++;}
    else if(n==="("||n===")"||n==="\\"){o+=n;i++;}
    else if(n>="0"&&n<="7"){let x=n;i++;for(let k=0;k<2&&s[i+1]>="0"&&s[i+1]<="7";k++)x+=s[++i];o+=String.fromCharCode(parseInt(x,8));}
    else if(n==="\n"){i++;}else{o+=n;i++;}
  }else o+=c;}return o;}
function _content2text(c){let text="",i=0;const n=c.length;
  while(i<n){const ch=c[i];
    if(ch==="("){let d=1,j=i+1,buf="";while(j<n&&d>0){const cj=c[j];if(cj==="\\"){buf+=cj+(c[j+1]||"");j+=2;continue;}
      if(cj==="(")d++;else if(cj===")"){d--;if(d===0)break;}buf+=cj;j++;}text+=_pdfStr(buf);i=j+1;continue;}
    if(ch==="<"&&c[i+1]!=="<"){let j=i+1,h="";while(j<n&&c[j]!==">"){h+=c[j];j++;}h=h.replace(/\s+/g,"");if(h.length%2)h+="0";
      for(let k=0;k<h.length;k+=2){const cd=parseInt(h.substr(k,2),16);if(!isNaN(cd))text+=String.fromCharCode(cd);}i=j+1;continue;}
    if(ch==="T"){const op=c.substr(i,2);if(op==="Td"||op==="TD"||op==="T*"){text+="\n";i+=2;continue;}}
    if(ch==="'"||ch==="\""){text+="\n";i++;continue;}
    i++;}return text;}
function extractPdfText(bytes){
  const raw=_l1(bytes);let content="";const re=/stream\r?\n/g;let m;
  // Skip non-text streams whose object dict marks them as font programs, image
  // XObjects, or object streams — their bytes contain stray "Tj"/"BT" and would
  // otherwise pollute the extracted text (common with LaTeX-embedded fonts).
  const SKIP=/\/(FontFile\d?|Length1|Type1C|CIDFontType0C|ObjStm)\b|\/Subtype\s*\/(Image|Type1C|CIDFontType0C)/;
  while((m=re.exec(raw))){const ss=m.index+m[0].length;const ei=raw.indexOf("endstream",ss);if(ei<0)continue;
    const objStart=raw.lastIndexOf("obj",m.index);
    const dict=objStart>=0?raw.slice(objStart, m.index):"";
    if(SKIP.test(dict)){ re.lastIndex=ei+9; continue; }
    let end=ei;if(raw[end-1]==="\n")end--;if(raw[end-1]==="\r")end--;const slice=bytes.subarray(ss,end);let dec;
    try{ if(slice.length>2&&(slice[0]&0x0f)===8&&(((slice[0]<<8|slice[1])%31)===0))dec=zInflate(slice); else dec=slice; }catch(e){dec=null;}
    if(dec){const s=_l1(dec);if(s.indexOf("Tj")>=0||s.indexOf("TJ")>=0||s.indexOf(" Td")>=0||s.indexOf("BT")>=0)content+=_content2text(s)+"\n";}
    re.lastIndex=ei+9;}
  return content.replace(/\r/g,"").replace(/[ \t]+\n/g,"\n").replace(/\n{3,}/g,"\n\n").trim();
}
function looksLikeText(t){ if(!t||t.length<40)return false;const letters=(t.match(/[A-Za-z]/g)||[]).length;
  const good=(t.match(/[A-Za-z0-9\s.,@()\/+#:&'"-]/g)||[]).length;return letters>=25&&good/t.length>=0.72; }

/* -- .docx text extraction (a docx is a ZIP of XML; reuse inflateRaw) -- */
function extractDocxText(bytes){
  const dv=bytes;
  const u16=o=>dv[o]|(dv[o+1]<<8);
  const u32=o=>(dv[o]|(dv[o+1]<<8)|(dv[o+2]<<16)|(dv[o+3]<<24))>>>0;
  // Scan local file headers (PK\x03\x04) for word/document.xml. Scanning by
  // signature (rather than trusting sizes) is robust to ZIP data descriptors.
  let dataStart=-1, method=8;
  for(let i=0;i+30<dv.length;i++){
    if(u32(i)===0x04034b50){
      const nameLen=u16(i+26), extraLen=u16(i+28);
      const name=_l1(dv.subarray(i+30,i+30+nameLen));
      if(name==="word/document.xml"){ method=u16(i+8); dataStart=i+30+nameLen+extraLen; break; }
    }
  }
  if(dataStart<0) return "";
  let raw;
  try{ raw = method===0 ? dv.subarray(dataStart) : inflateRaw(dv,dataStart); }catch(e){ return ""; }
  const xml=_l1(raw);
  const un=s=>s.replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&quot;/g,'"').replace(/&#39;|&apos;/g,"'").replace(/&amp;/g,"&");
  // Each <w:p> is a paragraph; <w:tab/> a tab. Strip remaining tags -> visible text.
  const text=xml.split(/<\/w:p>/).map(p=>
    un(p.replace(/<w:tab\/?>/g,"   ").replace(/<[^>]+>/g,"")).replace(/\s+$/,"")
  ).filter(l=>l.trim()).join("\n");
  return text.replace(/\n{3,}/g,"\n\n").trim();
}

/* -- LaTeX -> text -- */
function stripLatex(t){
  if(!/\\[a-zA-Z]+|\\documentclass|\$/.test(t)) return t;
  t=t.replace(/(^|[^\\])%.*$/gm,"$1");
  t=t.replace(/\\(documentclass|usepackage|geometry|pagestyle|hypersetup|titleformat|titlespacing|def|renewcommand|newcommand|setlength|input|include|vspace|hspace|rule)\s*(\[[^\]]*\])?\s*(\{[^{}]*\})*/g,"");
  t=t.replace(/\\(section|subsection|subsubsection|part|chapter)\*?\s*(\[[^\]]*\])?\s*\{([^{}]*)\}/g,"\n$3\n");  // section titles onto their own line
  t=t.replace(/\\begin\{[^}]*\}(\[[^\]]*\])?/g,"\n").replace(/\\end\{[^}]*\}/g,"\n");
  t=t.replace(/\\(textbf|textit|underline|emph|textsc|href|large|Large|huge|small|item)\*?\s*(\[[^\]]*\])?\s*\{/g," {");
  t=t.replace(/\\item\s*/g,"\n- ");
  t=t.replace(/\\hfill/g,"   ");           // horizontal fill -> stays on same line
  t=t.replace(/\\\\|\\newline|\\\s/g,"\n");
  t=t.replace(/[&~]/g," ").replace(/\\[,;:!%&_#{}]/g,m=>m[1]);
  t=t.replace(/\\[a-zA-Z]+\*?\s*(\[[^\]]*\])?/g," ");
  t=t.replace(/\$[^$]*\$/g," ").replace(/[{}]/g," ");
  return t.replace(/[ \t]{2,}/g," ").replace(/\n{3,}/g,"\n\n").trim();
}

/* -- text -> structured Resume -- */
const _SECMAP=[[/^(summary|objective|profile|about( me)?)\b/i,"summary"],
  [/^(technical skills|skills|core competencies|technologies|tech stack|competencies)\b/i,"skills"],
  [/^(experience|work experience|employment|professional experience|work history)\b/i,"experience"],
  [/^(education|academic background)\b/i,"education"],
  [/^(projects|personal projects|selected projects)\b/i,"projects"],
  [/^(certifications?|licens\w+|certificates?|awards?)\b/i,"certifications"]];
function _sectionOf(line){const l=line.trim().replace(/[:•\-–—\s]+$/,"");if(l.length>42)return null;
  for(const [re,k] of _SECMAP)if(re.test(l))return k;return null;}
function parseResumeText(rawText){
  const raw=(rawText||"").replace(/\r/g,"");
  const lines=raw.split("\n").map(l=>l.replace(/\s+$/,""));
  const nonEmpty=lines.filter(l=>l.trim());
  const emailM=raw.match(/[\w.+-]+@[\w-]+\.[\w.-]+/);
  const phoneM=raw.match(/(\+?\d[\d\s().-]{7,}\d)/);
  const links=[...new Set((raw.match(/((https?:\/\/)?(www\.)?(linkedin\.com|github\.com|gitlab\.com)\/[^\s|,)]+)/gi)||[]))].slice(0,4);
  let name="",title="";
  for(const l of nonEmpty){const s=l.trim();
    if(_sectionOf(s))continue; if(emailM&&s.includes(emailM[0]))continue;
    if(/@|https?:|linkedin|github|\d{3}[\s.-]*\d/i.test(s))continue;
    const w=s.split(/\s+/);
    if(!name&&w.length<=5&&/^[A-Za-z][A-Za-z.,'\- ]+$/.test(s)){name=s.replace(/,$/,"");continue;}
    if(name&&!title&&s.length<=60&&!/[.]\s/.test(s)){title=s;break;}}
  const sec={summary:[],skills:[],experience:[],education:[],projects:[],certifications:[]};let cur=null;
  for(const l of lines){const k=_sectionOf(l);if(k){cur=k;continue;}if(cur)sec[cur].push(l);}
  const clean=a=>a.filter(x=>x.trim());
  let skills=[];
  for(const l of clean(sec.skills))skills.push(...l.replace(/^[-•*·]\s*/,"").split(/[,|;•·]|\s{3,}/));
  skills=skills.map(s=>s.trim()).filter(s=>s&&s.length<40);
  const low=raw.toLowerCase();
  for(const sk of KNOWN_SKILLS){const re=(()=>{try{return new RegExp("(?<![A-Za-z0-9])"+sk.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")+"(?![A-Za-z0-9])","i");}catch(e){return null;}})();
    if(re&&re.test(low)&&!skills.some(x=>x.toLowerCase()===sk))skills.push(titleize(sk));}
  skills=[...new Map(skills.map(s=>[s.toLowerCase(),s])).values()];
  const experience=[];let entry=null;
  for(const l of clean(sec.experience)){
    const s=l.trim();
    const isBullet=/^[-•*·▪◦]\s+/.test(s);
    const hasDate=/((19|20)\d{2})/.test(s);
    const hasSep=/\s+(--|-|–|—|\||at)\s+/i.test(s);
    const header=!isBullet&&(hasDate||hasSep||(s.length<=46&&!/[.]$/.test(s)));
    if(header){ entry={title:s,company:"",location:"",start:"",end:"",bullets:[]};
      const dm=s.match(/((19|20)\d{2})\s*(?:--|-|–|—|to)?\s*(present|current|(19|20)\d{2})?/i);
      if(dm){entry.title=s.slice(0,dm.index).trim().replace(/[|,\-–—]\s*$/,"")||s;entry.start=dm[1];entry.end=(dm[3]||"").trim();}
      const sp=entry.title.split(/\s+(?:--|[-–—|])\s+|\s+at\s+/i);
      if(sp.length>=2){entry.title=sp[0].trim();entry.company=sp.slice(1).join(" ").trim();}
      if(entry.company) entry.company=entry.company.replace(/[\s(){}\[\]|,.–—-]+$/,"").trim();
      experience.push(entry);
    } else { if(!entry){entry={title:"Experience",company:"",location:"",start:"",end:"",bullets:[]};experience.push(entry);}
      entry.bullets.push(s.replace(/^[-•*·▪◦]\s+/,"")); }
  }
  const education=clean(sec.education).map(l=>{const p=l.split(/\s+(?:--|[-–—|])\s+|,\s*/);
    return {degree:p[0]||l.trim(),school:p[1]||"",location:"",year:(l.match(/(19|20)\d{2}/)||[""])[0],details:p.slice(2).join(", ")};});
  const certifications=clean(sec.certifications).flatMap(l=>l.replace(/^[-•*·]\s*/,"").split(/[,;]|\s{3,}/)).map(s=>s.trim()).filter(Boolean);
  const projects=clean(sec.projects).map(l=>l.replace(/^[-•*·]\s*/,"").trim()).filter(Boolean);
  const summary=clean(sec.summary).join(" ").trim();
  if(!experience.length){
    const body=nonEmpty.filter(l=>{const s=l.trim();return s!==name&&s!==title&&!_sectionOf(s)&&!(emailM&&s.includes(emailM[0]));});
    if(body.length)experience.push({title:"Experience",company:"",location:"",start:"",end:"",bullets:body.slice(0,25).map(x=>x.replace(/^[-•*·]\s*/,"").trim())});
  }
  return {name,title,email:emailM?emailM[0]:"",phone:phoneM?phoneM[0].trim():"",location:"",links,summary,skills,experience,education,certifications,projects,raw};
}


