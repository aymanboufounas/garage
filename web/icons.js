import {locale} from './i18n.js';
const paths={
 search:'<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/>',
 pin:'<path d="M20 10c0 6-8 11-8 11S4 16 4 10a8 8 0 1 1 16 0Z"/><circle cx="12" cy="10" r="2.5"/>',
 heart:'<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z"/>',
 clock:'<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
 calendar:'<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M7 3v4m10-4v4M3 11h18m-12 4h.01m3.99 0H13m3 0h.01"/>',
 arrow:'<path d="M4 12h16m-6-6 6 6-6 6"/>',
 chevron:'<path d="m9 5 7 7-7 7"/>',
 close:'<path d="m6 6 12 12M18 6 6 18"/>',
 check:'<path d="m5 12 4 4L19 6"/>',
 garage:'<path d="M3 21V9l9-6 9 6v12M7 21V11h10v10M7 15h10M7 18h10"/>',
 car:'<path d="m5 6-2 7v6h3v-2h12v2h3v-6l-2-7ZM3 13h18M7 6l1-2h8l1 2M7 14h.01M17 14h.01"/>',
 roof:'<path d="m3 10 9-7 9 7M6 10v11h12V10M9 21v-7h6v7"/>',
 height:'<path d="M12 3v18m-4-4 4 4 4-4M8 7l4-4 4 4M4 3H2v18h2m16-18h2v18h-2"/>',
 shield:'<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6Z"/><path d="m8 12 3 3 5-6"/>',
 locate:'<circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="1"/><path d="M12 2v4m0 12v4M2 12h4m12 0h4"/>',
 map:'<path d="m3 6 6-3 6 3 6-3v15l-6 3-6-3-6 3Zm6-3v15m6-12v15"/>',
 list:'<path d="M9 6h12M9 12h12M9 18h12M3 6h.01M3 12h.01M3 18h.01"/>',
 trip:'<rect x="4" y="7" width="16" height="14" rx="3"/><path d="M8 7V4h8v3M9 11v6m6-6v6"/>',
 chat:'<path d="M20 12a8 8 0 0 1-8 8 8.5 8.5 0 0 1-3.5-.8L4 20l.8-4.5A8 8 0 1 1 20 12Z"/><path d="M8 10h8M8 14h5"/>',
 directions:'<path d="m12 3 9 9-9 9-9-9 9-9Z"/><path d="M9 15v-4h6m-2-2 2 2-2 2"/>',
 user:'<circle cx="12" cy="8" r="4"/><path d="M4 21v-2a8 8 0 0 1 16 0v2"/>',
 plus:'<path d="M12 5v14M5 12h14"/>',
 leaf:'<path d="M20 3S4 1 4 12a7 7 0 0 0 12 5c4-4 4-14 4-14ZM4 21 15 10"/>',
 lock:'<rect x="5" y="10" width="14" height="11" rx="3"/><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 4v3"/>',
 info:'<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10h.01"/>',
 logout:'<path d="M9 4H4v16h5m5-4 4-4-4-4m-6 4h12"/>',
 camera:'<path d="M3 7h4l2-3h6l2 3h4v14H3Z"/><circle cx="12" cy="13" r="4"/>',
 sparkle:'<path d="m12 2 2.5 7.5L22 12l-7.5 2.5L12 22l-2.5-7.5L2 12l7.5-2.5Z"/>',
 money:'<rect x="2" y="6" width="20" height="13" rx="3"/><circle cx="12" cy="12.5" r="3"/><path d="M5 12h.01M19 12h.01"/>'
};
export const icon=name=>`<svg class="icon icon-${name}" viewBox="0 0 24 24" aria-hidden="true">${paths[name]||paths.info}</svg>`;
export const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const money=cents=>new Intl.NumberFormat(locale(),{maximumFractionDigits:2}).format(cents/100);
export const cityCenters={Casablanca:[33.586,-7.636],Rabat:[34.012,-6.843],Marrakech:[31.634,-8.006],Tangier:[35.768,-5.806],Nador:[35.168,-2.929],Fes:[34.033,-5.002],Meknes:[33.893,-5.554]};
const formatter=new Intl.DateTimeFormat('en-CA',{timeZone:'Africa/Casablanca',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
const parts=at=>Object.fromEntries(formatter.formatToParts(new Date(at)).filter(x=>x.type!=='literal').map(x=>[x.type,Number(x.value)]));
export function moroccoInput(at) {const p=parts(at);return `${p.year}-${String(p.month).padStart(2,'0')}-${String(p.day).padStart(2,'0')}T${String(p.hour).padStart(2,'0')}:${String(p.minute).padStart(2,'0')}`;}
export function fromMoroccoInput(str) {
 const match=/^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d)$/.exec(str);
 if(!match) throw new Error('Choose a start time.');
 const [,y,m,d,h,n]=match.map(Number);return zonedDate(y,m,d,h,n,0);
}
function zonedDate(y,m,d,h,n,s) {
 const wall=Date.UTC(y,m-1,d,h,n,s);let value=wall;
 for(let i=0;i<5;i++){const p=parts(value);const diff=wall-Date.UTC(p.year,p.month-1,p.day,p.hour,p.minute,p.second);if(diff===0)return value;value+=diff;}
 throw new Error('This time falls in a clock change. Choose another time.');
}
export function endAt(start,units,mode) {
 if(mode==='hourly') return start+units*3600000;
 const p=parts(start),total=p.month-1+units,y=p.year+Math.floor(total/12),m=total%12+1,d=Math.min(p.day,new Date(Date.UTC(y,m,0)).getUTCDate());
 return zonedDate(y,m,d,p.hour,p.minute,p.second);
}
export const dateLabel=at=>new Intl.DateTimeFormat(locale(),{timeZone:'Africa/Casablanca',day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'}).format(new Date(at));
export function safeImage(url){return typeof url==='string'&&/^\/assets\/[a-zA-Z0-9/_.-]+\.(webp|png|svg)$/.test(url)?url:'/assets/garage-placeholder.svg';}
