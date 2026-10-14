(() => {
  'use strict';
  const cfg = window.RESIDENCY_CONFIG || {};
  const sb = window.supabase?.createClient(cfg.supabaseUrl, cfg.supabasePublishableKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false }
  });
  if (!sb) return;

  const $ = id => document.getElementById(id);
  const qsa = s => [...document.querySelectorAll(s)];
  const pad = n => String(n).padStart(2, '0');
  const todayISO = () => {
    const d = new Date();
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
  };
  const dmy = v => {
    const d = new Date(`${v}T00:00:00`);
    return `${pad(d.getDate())}-${pad(d.getMonth()+1)}-${d.getFullYear()}`;
  };
  const money = n => `Rs. ${Number(n || 0).toLocaleString('en-PK', { maximumFractionDigits: 0 })}`;
  const esc = (s='') => String(s).replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
  function toast(msg){
    const t = $('toast');
    if(!t) return;
    t.textContent = msg;
    t.classList.remove('hidden');
    setTimeout(() => t.classList.add('hidden'), 2800);
  }

  function selectedStayId(){
    return document.querySelector('.cell-card.selected-cell[data-stay]')?.dataset.stay || null;
  }

  async function normalizeDetailsAction(){
    const details = $('selectedDetails');
    if(!details || details.classList.contains('hidden')) return;
    const id = selectedStayId();
    if(!id) return;
    const r = await sb.from('stays').select('id,status,room_no,start_date,end_date').eq('id', id).maybeSingle();
    if(r.error || !r.data) return;
    const s = r.data;
    let action = $('checkInStay') || $('markAvailable') || $('patchCheckIn');
    if(s.status === 'reserved'){
      if(!action) return;
      action.id = 'patchCheckIn';
      action.textContent = 'Check-In';
      action.className = 'checkin-action';
      const status = details.querySelector('.detail-item strong');
      if(status) status.textContent = 'Booked';
    } else if(s.status === 'active'){
      if(action && action.id === 'patchCheckIn'){
        action.id = 'markAvailable';
        action.textContent = 'Mark Available';
        action.className = 'neutral';
      }
      const status = details.querySelector('.detail-item strong');
      if(status) status.textContent = 'Check-In';
    }
  }

  async function doCheckIn(){
    const id = selectedStayId();
    if(!id) return toast('Select the booked room again.');
    const r = await sb.from('stays').select('*').eq('id', id).maybeSingle();
    if(r.error || !r.data) return toast(r.error?.message || 'Booking could not be found.');
    const s = r.data;
    if(s.status !== 'reserved') return toast('This booking is already checked in.');
    const today = todayISO();
    if(today < s.start_date) return toast(`Booking starts on ${dmy(s.start_date)}. Check-In is not available yet.`);
    const clash = await sb.from('stays').select('id,guest_name').eq('room_no', Number(s.room_no)).lte('start_date', today).gte('end_date', today).in('status', ['reserved','active']).neq('id', s.id).limit(1);
    if(clash.error) return toast(clash.error.message);
    if(clash.data?.length) return toast(`Room ${s.room_no} is already booked today.`);
    const newEnd = s.end_date < today ? today : s.end_date;
    const up = await sb.from('stays').update({ status:'active', end_date:newEnd }).eq('id', s.id);
    if(up.error) return toast(up.error.message.includes('no_room_overlap') ? `Room ${s.room_no} is already booked today.` : up.error.message);
    toast(`Room ${s.room_no} checked in`);
    setTimeout(() => { recolorCheckedInRooms(); normalizeDetailsAction(); }, 250);
  }

  async function recolorCheckedInRooms(){
    const today = todayISO();
    const r = await sb.from('stays').select('id,room_no,status,start_date,end_date').eq('status','active').lte('start_date',today).gte('end_date',today);
    if(r.error) return;
    const activeRooms = new Set((r.data || []).map(x => Number(x.room_no)));
    qsa(`.cell-card[data-date="${today}"]`).forEach(card => {
      const room = Number(card.dataset.room);
      if(!activeRooms.has(room)) return;
      card.classList.remove('available','booked','continue');
      card.classList.add('checkin');
      const label = card.querySelector('.cell-status');
      if(label) label.textContent = 'Check-In';
    });
  }

  function patchBookingAutofill(){
    const guest = $('fGuest');
    if(!guest || guest.dataset.autofillPatched === '1') return;
    const isNew = String($('modalTitle')?.textContent || '').startsWith('Occupy Room');
    const nonce = Date.now();
    [['fGuest','guest'],['fMobile','mobile'],['fRent','rent'],['fAdvance','advance']].forEach(([id,key]) => {
      const el = $(id);
      if(!el) return;
      el.dataset.autofillPatched = '1';
      el.setAttribute('name', `new_booking_${key}_${nonce}`);
      el.setAttribute('autocomplete','off');
      el.setAttribute('autocorrect','off');
      el.setAttribute('spellcheck','false');
      el.setAttribute('data-lpignore','true');
      el.setAttribute('data-form-type','other');
      if(isNew) el.value = '';
    });
  }

  const norm = (v='') => String(v).toLowerCase().replace(/[^a-z0-9\s]/g,' ').replace(/\s+/g,' ').trim();
  function editDistance(a,b){
    a=norm(a); b=norm(b);
    const prev=Array.from({length:b.length+1},(_,i)=>i);
    for(let i=1;i<=a.length;i++){
      let left=i, diag=i-1;
      for(let j=1;j<=b.length;j++){
        const up=prev[j];
        const cur=a[i-1]===b[j-1] ? diag : 1+Math.min(diag,up,left);
        prev[j]=cur; diag=up; left=cur;
      }
    }
    return prev[b.length];
  }
  function matchScore(row,q){
    const raw=norm(q); if(!raw) return 999;
    const name=norm(row.guest_name), mobile=String(row.mobile||'').replace(/\D/g,''), digits=String(q).replace(/\D/g,'');
    if(digits.length>=3 && mobile.includes(digits)) return 0;
    if(name.startsWith(raw)) return 0;
    const needle=raw.split(' ')[0];
    const words=name.split(' ').filter(Boolean);
    if(words.some(w=>w.startsWith(needle))) return 1;
    if(name.includes(raw)) return 2;
    if(needle.length>=3){
      const maxDist=needle.length>=7 ? 2 : 1;
      if(words.some(w=>editDistance(w,needle)<=maxDist)) return 3;
    }
    return 999;
  }
  function resetGuestResults(clearInput=false){
    if(clearInput && $('guestSearch')) $('guestSearch').value='';
    const box=$('guestResults');
    if(!box) return;
    box.className='card-list empty-state';
    box.textContent='Start typing a guest name or mobile number.';
  }
  let searchTimer=null, searchSeq=0;
  async function liveGuestSearch(){
    const box=$('guestResults'), input=$('guestSearch');
    if(!box || !input) return;
    const q=input.value.trim();
    if(!q){ resetGuestResults(false); return; }
    const seq=++searchSeq;
    const r=await sb.from('stays').select('guest_name,mobile,room_no,start_date,rent,status').neq('status','cancelled').order('start_date',{ascending:false}).limit(600);
    if(seq!==searchSeq) return;
    if(r.error) return toast(r.error.message);
    const grouped=new Map();
    for(const x of (r.data||[])){
      const key=`${norm(x.guest_name)}|${String(x.mobile||'').trim()}`;
      if(!grouped.has(key)) grouped.set(key,{guest_name:x.guest_name||'',mobile:x.mobile||'',total_stays:0,total_rent:0,last_room:x.room_no,last_date:x.start_date});
      const g=grouped.get(key); g.total_stays++; g.total_rent+=Number(x.rent||0);
    }
    const rows=[...grouped.values()].map(x=>({...x,_score:matchScore(x,q)})).filter(x=>x._score<999).sort((a,b)=>a._score-b._score||String(b.last_date||'').localeCompare(String(a.last_date||''))).slice(0,20);
    box.className='card-list';
    box.innerHTML=rows.length ? rows.map(x=>`<article class="guest-card"><h3>${esc(x.guest_name)}</h3><p>${esc(x.mobile)} • ${x.total_stays} stay(s)</p><p>Last room: ${x.last_room} • Last visit: ${x.last_date?dmy(x.last_date):'-'}</p><p>Total Rent: ${money(x.total_rent)}</p></article>`).join('') : '<div class="empty-state">No matching guest found.</div>';
  }

  document.addEventListener('click', e => {
    const target=e.target;
    if(target?.id==='patchCheckIn'){
      e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
      doCheckIn();
      return;
    }
    if(target?.id==='guestSearchBtn'){
      e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
      clearTimeout(searchTimer); liveGuestSearch();
      return;
    }
    const nav=target?.closest?.('.nav-btn');
    if(nav && nav.dataset.page!=='guests') setTimeout(()=>resetGuestResults(true),0);
  }, true);

  document.addEventListener('keydown', e => {
    if(e.target?.id==='guestSearch' && e.key==='Enter'){
      e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
      clearTimeout(searchTimer); liveGuestSearch();
    }
  }, true);

  document.addEventListener('input', e => {
    if(e.target?.id!=='guestSearch') return;
    clearTimeout(searchTimer);
    if(!e.target.value.trim()) { resetGuestResults(false); return; }
    searchTimer=setTimeout(liveGuestSearch,160);
  }, true);

  const observer=new MutationObserver(() => {
    patchBookingAutofill();
    normalizeDetailsAction();
    clearTimeout(observer._calendarTimer);
    observer._calendarTimer=setTimeout(recolorCheckedInRooms,120);
  });
  observer.observe(document.body,{childList:true,subtree:true});
  setTimeout(()=>{ patchBookingAutofill(); normalizeDetailsAction(); recolorCheckedInRooms(); },500);
})();
