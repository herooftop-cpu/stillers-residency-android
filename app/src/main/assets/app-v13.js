(() => {
  'use strict';
  const cfg = window.RESIDENCY_CONFIG || {};
  const $ = id => document.getElementById(id);
  const qs = s => document.querySelector(s);
  const qsa = s => [...document.querySelectorAll(s)];
  const rooms = [101,102,103,104,105,106,107,108];
  let viewDays = Number(localStorage.getItem('residency_view_days') || 30);
  if(![7,15,30].includes(viewDays)) viewDays=30;
  let sb = null, authUser = null, profile = null, weekStart = viewDays===30 ? new Date(new Date().getFullYear(),new Date().getMonth(),1) : startOfWeek(new Date()), stays = [], selectedStay = null, selectedReportRoom = null, selectedCellKey = null;
  let locked = localStorage.getItem('residency_locked') === '1';
  const deviceId = localStorage.getItem('residency_device_id') || crypto.randomUUID();
  localStorage.setItem('residency_device_id', deviceId);
  const deviceName = window.RESIDENCY_ANDROID ? 'Android Mobile' : (/Android/i.test(navigator.userAgent) ? 'Android Mobile' : 'PC / Browser');

  function iso(d){ return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`; }
  function pad(n){ return String(n).padStart(2,'0'); }
  function dmy(v){ const d = typeof v === 'string' ? new Date(v+'T00:00:00') : v; return `${pad(d.getDate())}-${pad(d.getMonth()+1)}-${d.getFullYear()}`; }
  function shortDate(d){ return d.toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric'}); }
  function money(n){ return `Rs. ${Number(n||0).toLocaleString('en-PK',{maximumFractionDigits:0})}`; }
  function startOfWeek(d){ const x=new Date(d); x.setHours(0,0,0,0); const day=(x.getDay()+6)%7; x.setDate(x.getDate()-day); return x; }
  function addDays(d,n){ const x=new Date(d); x.setDate(x.getDate()+n); return x; }
  function todayISO(){ return iso(new Date()); }
  function rangeEnd(){ return viewDays===30 ? new Date(weekStart.getFullYear(),weekStart.getMonth()+1,0) : addDays(weekStart,viewDays-1); }
  function rangeCount(){ return Math.round((rangeEnd()-weekStart)/86400000)+1; }
  function moveRange(dir){ if(viewDays===30){ weekStart=new Date(weekStart.getFullYear(),weekStart.getMonth()+dir,1); } else { weekStart=addDays(weekStart,dir*viewDays); } }
  function show(el){ el.classList.remove('hidden'); }
  function hide(el){ el.classList.add('hidden'); }
  function toast(msg){ const t=$('toast'); t.textContent=msg; show(t); setTimeout(()=>hide(t),2600); }
  function esc(s=''){ return String(s).replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c])); }
  function role(){ return profile?.role || 'viewer'; }
  function isMainAdmin(){ return role()==='admin' && !!profile?.is_owner; }
  function canEdit(){ return role()==='admin' && !locked; }
  function syncRoleUI(){
    document.body.classList.toggle('viewer', role()!=='admin');
    document.body.classList.toggle('locked', locked);
    $('roleBadge').textContent = isMainAdmin() ? 'MAIN ADMIN' : (role()==='admin' ? 'MANAGER' : 'VIEWER');
    $('lockBtn').textContent=locked?'🔒':'🔓';
    $('lockBtn').title=locked?'Unlock editing':'Lock editing';
    if($('usersBtn')) $('usersBtn').classList.toggle('hidden', !isMainAdmin());
    if($('lockPasswordBtn')) $('lockPasswordBtn').classList.toggle('hidden', !isMainAdmin());
    if($('accountBtn')) $('accountBtn').textContent = isMainAdmin() ? 'Main Admin Account' : 'My Password';
  }
  function setMessage(text,type=''){ const m=$('authMessage'); if(!text){hide(m);return;} m.textContent=text; m.className='message'+(type?` ${type}`:''); show(m); }
  function openModal(title,html){ $('modalTitle').textContent=title; $('modalBody').innerHTML=html; show($('modal')); }
  function closeModal(){ hide($('modal')); $('modalBody').innerHTML=''; }
  $('modalClose').onclick=closeModal;
  $('modal').addEventListener('click',e=>{ if(e.target===$('modal')) closeModal(); });

  async function boot(){
    setTimeout(()=>hide($('splash')),900);
    if(!cfg.supabaseUrl || cfg.supabaseUrl.includes('__SUPABASE') || !cfg.supabasePublishableKey || cfg.supabasePublishableKey.includes('__SUPABASE')){
      setTimeout(()=>{ show($('authView')); setMessage('Cloud setup is not connected yet. Add the new Stiller\'s Residency Supabase Project URL and Publishable Key.'); },950); return;
    }
    sb = window.supabase.createClient(cfg.supabaseUrl,cfg.supabasePublishableKey,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:false}});
    try{
      let {data:{session}}=await sb.auth.getSession();
      if(!session){ const r=await sb.auth.signInAnonymously(); if(r.error) throw r.error; session=r.data.session; }
      authUser=session.user;
      const s=await sb.rpc('my_app_session');
      if(s.error) throw s.error;
      if(s.data && s.data.length && s.data[0].active){ profile=s.data[0]; await enterApp(); } else { show($('authView')); }
    }catch(e){ show($('authView')); setMessage(e.message||'Could not connect to cloud.'); }
  }

  $('loginBtn').onclick=async()=>{
    if(!sb) return;
    setMessage('');
    const u=$('loginUsername').value.trim(), p=$('loginPassword').value;
    if(!u||!p) return setMessage('Enter username and password.');
    const r=await sb.rpc('login_app_account',{p_username:u,p_password:p,p_device_id:deviceId,p_device_name:deviceName});
    if(r.error) return setMessage(r.error.message);
    const s=await sb.rpc('my_app_session');
    if(s.error||!s.data?.length) return setMessage('Login could not be confirmed.');
    profile=s.data[0]; await enterApp();
  };

  $('firstSetupBtn').onclick=()=>openModal('First-Time Admin Setup',`
    <div class="form-grid">
      <label>Admin Username<input id="setupUser" autocomplete="off"></label>
      <label>Admin Password<input id="setupPass" type="password"></label>
      <label>Lock Password<input id="setupLock" type="password"></label>
    </div><div class="modal-actions"><button id="doSetup" class="primary">Create Admin</button></div>`);
  document.addEventListener('click',async e=>{
    if(e.target?.id==='doSetup'){
      const r=await sb.rpc('bootstrap_admin',{p_username:$('setupUser').value.trim(),p_password:$('setupPass').value,p_lock_password:$('setupLock').value,p_device_id:deviceId,p_device_name:deviceName});
      if(r.error) return toast(r.error.message);
      const data=r.data;
      openModal('Save Your Recovery Code',`<p>This code is shown for recovery. Save it safely.</p><div style="font-size:28px;font-weight:900;text-align:center;padding:20px;background:#f5f7f9;border-radius:12px">${esc(data.recovery_code)}</div><div class="modal-actions"><button id="finishSetup" class="primary">I Saved It</button></div>`);
    }
    if(e.target?.id==='finishSetup'){ closeModal(); const s=await sb.rpc('my_app_session'); profile=s.data?.[0]; await enterApp(); }
  });

  $('recoverBtn').onclick=()=>openModal('Recover Admin Login',`<div class="form-grid">
    <label>Recovery Code<input id="recoveryCode" placeholder="SR-XXXX-XXXX"></label>
    <label>New Admin Username<input id="recoveryUser"></label>
    <label>New Admin Password<input id="recoveryPass" type="password"></label>
    </div><div class="modal-actions"><button id="doRecovery" class="primary">Reset Admin Login</button></div>`);
  document.addEventListener('click',async e=>{
    if(e.target?.id==='doRecovery'){
      const r=await sb.rpc('recover_owner_admin',{p_recovery_code:$('recoveryCode').value.trim(),p_new_username:$('recoveryUser').value.trim(),p_new_password:$('recoveryPass').value});
      if(r.error) return toast(r.error.message); closeModal(); setMessage('Admin login reset. Sign in with the new username and password.','success');
    }
  });

  async function enterApp(){
    hide($('authView')); show($('appView')); $('userLine').textContent=`${isMainAdmin()?'Main Admin':(profile.role==='admin'?'Manager':'Viewer')} • ${profile.username}`; syncRoleUI();
    await heartbeat(); await loadWeek(); subscribeRealtime(); renderCurrentPage();
    setInterval(heartbeat,45000); setInterval(refreshSession,60000);
    if(!window.RESIDENCY_ANDROID) await registerServiceWorker();
    setTimeout(offerNotificationSetup,700);
  }
  function offerNotificationSetup(){
    if(localStorage.getItem('residency_notify_prompted')==='1') return;
    if(window.RESIDENCY_ANDROID && window.AndroidNative){
      openModal('Enable Booking Notifications',`<p>Allow Stiller's Residency to show booking notifications on this Android device.</p><div class="modal-actions"><button id="notifyLater" class="neutral">Later</button><button id="notifyNow" class="primary">Enable Notifications</button></div>`);
      $('notifyLater').onclick=()=>{ localStorage.setItem('residency_notify_prompted','1'); closeModal(); };
      $('notifyNow').onclick=()=>{ localStorage.setItem('residency_notify_prompted','1'); closeModal(); registerPush(); };
      return;
    }
    if(!('Notification' in window) || Notification.permission!=='default') return;
    openModal('Enable Booking Notifications',`<p>Receive a notification when another device creates a new room booking. The device that creates the booking will not receive its own notification.</p><div class="modal-actions"><button id="notifyLater" class="neutral">Later</button><button id="notifyNow" class="primary">Enable Notifications</button></div>`);
    $('notifyLater').onclick=()=>{ localStorage.setItem('residency_notify_prompted','1'); closeModal(); };
    $('notifyNow').onclick=async()=>{ localStorage.setItem('residency_notify_prompted','1'); closeModal(); await registerPush(); };
  }
  async function heartbeat(){ if(!sb) return; await sb.rpc('heartbeat',{p_device_id:deviceId,p_device_name:deviceName}); }
  async function refreshSession(){ if(!sb)return; const s=await sb.rpc('my_app_session'); if(s.error||!s.data?.length||!s.data[0].active){ location.reload(); return; } const old=profile.role; profile=s.data[0]; if(old!==profile.role){toast(`Role changed to ${profile.role}`); syncRoleUI(); renderCalendar();} }

  let channel=null;
  function notifyNewBooking(record){
    if(!record || record.created_by_device===deviceId) return;
    const title='New Booking';
    const body=`Room ${record.room_no} — ${record.guest_name}\nRent: ${money(record.rent)}`;
    if(window.RESIDENCY_ANDROID && window.AndroidNative?.showNotification){
      try{ window.AndroidNative.showNotification(title,body); }catch(_){}
      return;
    }
    if('Notification' in window && Notification.permission==='granted'){
      try{ new Notification(title,{body}); }catch(_){}
    }
  }
  function subscribeRealtime(){
    if(channel) sb.removeChannel(channel);
    channel=sb.channel('stays-live').on('postgres_changes',{event:'*',schema:'public',table:'stays'},async payload=>{
      if(payload?.eventType==='INSERT') notifyNewBooking(payload.new);
      await loadWeek();
      if(!qs('#reportsPage.hidden')) loadReport();
    }).subscribe();
  }

  async function loadWeek(){
    const from=iso(addDays(weekStart,-1)), to=iso(rangeEnd());
    const r=await sb.from('stays').select('*').lte('start_date',to).gte('end_date',from).neq('status','cancelled').order('room_no').order('start_date');
    if(r.error){toast(r.error.message);return;} stays=r.data||[]; renderCalendar();
  }

  function sameGuestIdentity(a,b){
    const am=String(a?.mobile||'').replace(/\D/g,''), bm=String(b?.mobile||'').replace(/\D/g,'');
    if(am && bm && am===bm) return true;
    const an=guestNorm(a?.guest_name||''), bn=guestNorm(b?.guest_name||'');
    return !!an && an===bn;
  }
  function isContinuationCell(stay,dateIso){
    if(dateIso>stay.start_date) return true;
    if(dateIso!==stay.start_date) return false;
    const prev=iso(addDays(new Date(dateIso+'T00:00:00'),-1));
    return stays.some(x=>x.id!==stay.id && x.status!=='cancelled' && x.end_date===prev && sameGuestIdentity(x,stay));
  }
  function statusFor(stay,dateIso){
    if(isContinuationCell(stay,dateIso)) return ['Continue','continued'];
    if(stay.status==='active' && dateIso===stay.start_date) return ['Check-In','checkin'];
    if(dateIso===stay.start_date) return ['Booked','booked'];
    return ['Booked','booked'];
  }
  function activeStayFor(room,dateIso){ return stays.find(s=>Number(s.room_no)===Number(room)&&s.start_date<=dateIso&&s.end_date>=dateIso&&s.status!=='cancelled' && !(s.status==='completed' && s.checkout_date && dateIso>=s.checkout_date)); }

  function renderCalendar(){
    $('weekPicker').textContent=`${shortDate(weekStart)} – ${shortDate(rangeEnd())}`;
    if($('viewDays')) $('viewDays').value=String(viewDays);
    let h='<table class="calendar"><thead><tr><th>Date</th>'+rooms.map(r=>`<th>Room ${r}</th>`).join('')+'</tr></thead><tbody>';
    for(let i=0;i<rangeCount();i++){
      const d=addDays(weekStart,i), di=iso(d);
      h+=`<tr><td class="date-cell">${d.toLocaleDateString('en-US',{weekday:'short'})}<small>${shortDate(d)}</small></td>`;
      for(const room of rooms){
        const s=activeStayFor(room,di);
        const key=`${room}|${di}`;
        const selected=selectedCellKey===key?' selected-cell':'';
        if(!s){
          h+=`<td class="room-cell"><div class="cell-card available${selected}" data-room="${room}" data-date="${di}" data-empty="1"><div class="cell-status">Available</div>${canEdit()?'<div class="plus">+</div>':''}</div></td>`;
        }else{
          const [label,cls]=statusFor(s,di);
          h+=`<td class="room-cell"><div class="cell-card ${cls}${selected}" data-room="${room}" data-stay="${s.id}" data-date="${di}"><div class="cell-status">${label}</div><div class="cell-guest">${esc(s.guest_name)}</div><div class="cell-mobile">${esc(s.mobile||'')}</div><div class="cell-money">Rent: ${money(s.rent)}<br>Adv: ${money(s.advance)}</div></div></td>`;
        }
      }
      h+='</tr>';
    }
    h+='</tbody></table>';
    $('calendarWrap').innerHTML=h;
    qsa('.cell-card').forEach(el=>{
      const selectCell=()=>{
        selectedCellKey=`${el.dataset.room}|${el.dataset.date}`;
        qsa('.cell-card.selected-cell').forEach(x=>x.classList.remove('selected-cell'));
        el.classList.add('selected-cell');
      };
      el.onclick=()=>{ selectCell(); if(el.dataset.empty==='1'){ if(canEdit()) openBookingForm(Number(el.dataset.room),el.dataset.date); } else openStayDetails(el.dataset.stay,el.dataset.date); };
      el.oncontextmenu=e=>{ e.preventDefault(); selectCell(); if(el.dataset.empty==='1'&&canEdit()) openBookingForm(Number(el.dataset.room),el.dataset.date); };
    });
  }

  if($('viewDays')) $('viewDays').onchange=async()=>{
    viewDays=Number($('viewDays').value||30);
    localStorage.setItem('residency_view_days',String(viewDays));
    weekStart=viewDays===30 ? new Date(new Date().getFullYear(),new Date().getMonth(),1) : startOfWeek(new Date());
    selectedCellKey=null;
    hide($('selectedDetails'));
    await loadWeek();
  };

  function openBookingForm(room,date,existing=null){
    if(!canEdit()) return;
    openModal(existing?'Edit Booking':`Occupy Room ${room} • ${dmy(date)}`,`<div class="form-grid">
      <label>Guest Name<input id="fGuest" value="${esc(existing?.guest_name||'')}"></label>
      <label>Mobile Number<input id="fMobile" inputmode="tel" value="${esc(existing?.mobile||'')}"></label>
      <label>Rent (Rs.)<input id="fRent" type="number" min="0" value="${existing?.rent??''}"></label>
      <label>Advance (Rs.)<input id="fAdvance" type="number" min="0" value="${existing?.advance??''}"></label>
    </div><div class="modal-actions"><button id="saveStay" class="primary">${existing?'Save Changes':'Save Booking'}</button></div>`);
    $('saveStay').onclick=async()=>{
      const payload={room_no:room,guest_name:$('fGuest').value.trim(),mobile:$('fMobile').value.trim(),rent:Number($('fRent').value||0),advance:Number($('fAdvance').value||0)};
      if(!payload.guest_name||!payload.mobile) return toast('Guest name and mobile number are required.');
      let r;
      if(existing){ r=await sb.from('stays').update(payload).eq('id',existing.id); }
      else { Object.assign(payload,{start_date:date,end_date:date,status:date===todayISO()?'active':'reserved',created_by_device:deviceId}); r=await sb.from('stays').insert(payload); }
      if(r.error) return toast(r.error.message.includes('no_room_overlap')?'This room is already occupied/booked for that date.':r.error.message);
      closeModal(); toast(existing?'Booking updated':'Booking saved'); await loadWeek();
    };
  }

  function openStayDetails(id,dateIso){
    const s=stays.find(x=>x.id===id); if(!s)return; selectedStay=s;
    const [label]=statusFor(s,dateIso);
    const canCheckIn=canEdit() && dateIso===todayISO() && s.status==='reserved' && s.start_date<=todayISO() && s.end_date>=todayISO();
    $('selectedDetails').innerHTML=`<div class="details-grid">
      <div class="detail-item"><small>Status</small><strong>${label}</strong></div><div class="detail-item"><small>Room</small><strong>${s.room_no}</strong></div><div class="detail-item"><small>Guest Name</small><strong>${esc(s.guest_name)}</strong></div><div class="detail-item"><small>Mobile Number</small><strong>${esc(s.mobile)}</strong></div><div class="detail-item"><small>Rent</small><strong>${money(s.rent)}</strong></div><div class="detail-item"><small>Advance</small><strong>${money(s.advance)}</strong></div><div class="detail-item"><small>Start Date</small><strong>${dmy(s.start_date)}</strong></div><div class="detail-item"><small>Reserved Through</small><strong>${dmy(s.end_date)}</strong></div>
      </div>${canEdit()?`<div class="detail-actions admin-edit"><button class="neutral" id="editStay">Edit</button>${canCheckIn?'<button class="checkin-action" id="checkInStay">Check-In</button>':''}<button class="success" id="continueStay">Continue</button><button class="neutral" id="markAvailable">Mark Available</button><button class="danger" id="deleteStay">Delete</button></div>`:''}`;
    show($('selectedDetails'));
    if(canEdit()){
      $('editStay').onclick=()=>openBookingForm(Number(s.room_no),s.start_date,s);
      if(canCheckIn) $('checkInStay').onclick=async()=>{
        const r=await sb.from('stays').update({status:'active'}).eq('id',s.id);
        if(r.error)return toast(r.error.message);
        toast(`Room ${s.room_no} checked in`);
        await loadWeek();
        openStayDetails(s.id,dateIso);
      };
      $('continueStay').onclick=()=>openContinueOptions(s);
      $('markAvailable').onclick=()=>confirmAction(`Mark Room ${s.room_no} available now?`,async()=>{ const r=await sb.rpc('mark_stay_available',{p_stay_id:s.id}); if(r.error)return toast(r.error.message); toast('Room marked available'); hide($('selectedDetails')); selectedCellKey=null; await loadWeek(); });
      $('deleteStay').onclick=()=>confirmAction(`Delete booking for ${s.guest_name}?`,async()=>{ const r=await sb.from('stays').delete().eq('id',s.id); if(r.error)return toast(r.error.message); toast('Booking deleted'); hide($('selectedDetails')); selectedCellKey=null; await loadWeek(); });
    }
  }

  function openContinueOptions(s){
    const next=iso(addDays(new Date(s.end_date+'T00:00:00'),1));
    openModal('Continue Stay',`<p><strong>${esc(s.guest_name)}</strong> • Next date: <strong>${dmy(next)}</strong></p><p>Will the guest stay in the same room or change room?</p><div class="continue-choice"><button id="continueSame" class="success">Same Room ${s.room_no}</button><button id="continueChange" class="neutral">Change Room</button></div>`);
    $('continueSame').onclick=async()=>{
      const q=await sb.from('stays').select('id').eq('room_no',Number(s.room_no)).lte('start_date',next).gte('end_date',next).in('status',['reserved','active']).neq('id',s.id).limit(1);
      if(q.error)return toast(q.error.message);
      if(q.data?.length) return toast(`Next date is already booked for Room ${s.room_no}.`);
      const r=await sb.from('stays').update({end_date:next,status:s.status==='reserved'?'reserved':'active'}).eq('id',s.id);
      if(r.error)return toast(r.error.message.includes('no_room_overlap')?`Next date is already booked for Room ${s.room_no}.`:r.error.message);
      closeModal(); toast(`Stay continued in Room ${s.room_no}`); await loadWeek();
    };
    $('continueChange').onclick=()=>openRoomChangeOptions(s,next);
  }

  async function openRoomChangeOptions(s,next){
    const q=await sb.from('stays').select('room_no').lte('start_date',next).gte('end_date',next).in('status',['reserved','active']);
    if(q.error)return toast(q.error.message);
    const occupied=new Set((q.data||[]).map(x=>Number(x.room_no)));
    const available=rooms.filter(r=>r!==Number(s.room_no)&&!occupied.has(r));
    if(!available.length) return toast('No other room is available on the next date.');
    openModal('Change Room',`<p>Next date: <strong>${dmy(next)}</strong></p><div class="form-grid"><label>Select Available Room<select id="moveRoom">${available.map(r=>`<option value="${r}">Room ${r}</option>`).join('')}</select></label></div><div class="modal-actions"><button id="saveRoomChange" class="primary">Continue in Selected Room</button></div>`);
    $('saveRoomChange').onclick=async()=>{
      const room=Number($('moveRoom').value);
      const recheck=await sb.from('stays').select('id').eq('room_no',room).lte('start_date',next).gte('end_date',next).in('status',['reserved','active']).limit(1);
      if(recheck.error)return toast(recheck.error.message);
      if(recheck.data?.length) return toast(`Room ${room} is already booked on ${dmy(next)}.`);
      const payload={room_no:room,guest_name:s.guest_name,mobile:s.mobile,rent:Number(s.rent||0),advance:0,start_date:next,end_date:next,status:'active',created_by_device:deviceId};
      const r=await sb.from('stays').insert(payload);
      if(r.error)return toast(r.error.message.includes('no_room_overlap')?`Room ${room} is already booked on ${dmy(next)}.`:r.error.message);
      closeModal(); toast(`Guest continued in Room ${room}`); await loadWeek();
    };
  }

  function confirmAction(text,fn){ openModal('Confirm',`<p>${esc(text)}</p><div class="modal-actions"><button id="cancelConfirm" class="neutral">Cancel</button><button id="yesConfirm" class="danger">Confirm</button></div>`); $('cancelConfirm').onclick=closeModal; $('yesConfirm').onclick=async()=>{closeModal(); await fn();}; }

  $('prevWeek').onclick=async()=>{moveRange(-1);await loadWeek();}; $('nextWeek').onclick=async()=>{moveRange(1);await loadWeek();};

  qsa('.nav-btn').forEach(b=>b.onclick=()=>switchPage(b.dataset.page));
  function resetGuestSearch(){
    if(!$('guestSearch')||!$('guestResults')) return;
    $('guestSearch').value='';
    $('guestResults').innerHTML='';
    $('guestResults').className='card-list hidden';
  }
  function switchPage(page){
    qsa('.nav-btn').forEach(x=>x.classList.toggle('active',x.dataset.page===page));
    qsa('.page').forEach(x=>hide(x));
    show($(page+'Page'));
    if(page==='reports') loadReport();
    if(page==='guests') $('guestSearch').focus();
    else resetGuestSearch();
  }
  function renderCurrentPage(){ switchPage('calendar'); }

  function guestNorm(v=''){ return String(v).toLowerCase().replace(/[^a-z0-9\s]/g,' ').replace(/\s+/g,' ').trim(); }
  function editDistance(a,b){
    a=guestNorm(a); b=guestNorm(b);
    const prev=Array.from({length:b.length+1},(_,i)=>i);
    for(let i=1;i<=a.length;i++){
      let left=i, diag=i-1;
      for(let j=1;j<=b.length;j++){
        const up=prev[j];
        const cur=a[i-1]===b[j-1]?diag:1+Math.min(diag,up,left);
        prev[j]=cur; diag=up; left=cur;
      }
    }
    return prev[b.length];
  }
  function guestMatchScore(row,q){
    const raw=guestNorm(q); if(!raw) return 999;
    const name=guestNorm(row.guest_name), mobile=String(row.mobile||'').replace(/\D/g,''), digits=String(q).replace(/\D/g,'');
    if(digits.length>=3 && mobile.includes(digits)) return 0;
    if(name.startsWith(raw)) return 0;
    const needle=raw.split(' ')[0];
    const words=name.split(' ').filter(Boolean);
    if(words.some(w=>w.startsWith(needle))) return 1;
    if(name.includes(raw)) return 2;
    if(needle.length>=3){
      const maxDist=needle.length>=7?2:1;
      if(words.some(w=>editDistance(w,needle)<=maxDist)) return 3;
    }
    return 999;
  }

  let guestSearchTimer=null;
  $('guestSearchBtn').onclick=searchGuests;
  $('guestSearch').addEventListener('keydown',e=>{if(e.key==='Enter'){clearTimeout(guestSearchTimer);searchGuests();}});
  $('guestSearch').addEventListener('input',()=>{
    clearTimeout(guestSearchTimer);
    const q=$('guestSearch').value.trim();
    if(!q){ resetGuestSearch(); return; }
    guestSearchTimer=setTimeout(searchGuests,180);
  });
  async function searchGuests(){
    const q=$('guestSearch').value.trim();
    if(!q){ resetGuestSearch(); return; }
    const r=await sb.from('stays').select('guest_name,mobile,room_no,start_date,rent,status').neq('status','cancelled').order('start_date',{ascending:false}).limit(600);
    if(r.error)return toast(r.error.message);
    const grouped=new Map();
    for(const x of (r.data||[])){
      const key=`${guestNorm(x.guest_name)}|${String(x.mobile||'').trim()}`;
      if(!grouped.has(key)) grouped.set(key,{guest_name:x.guest_name||'',mobile:x.mobile||'',total_stays:0,total_rent:0,last_room:x.room_no,last_date:x.start_date});
      const g=grouped.get(key); g.total_stays+=1; g.total_rent+=Number(x.rent||0);
    }
    const rows=[...grouped.values()].map(x=>({...x,_score:guestMatchScore(x,q)})).filter(x=>x._score<999).sort((a,b)=>a._score-b._score||String(b.last_date||'').localeCompare(String(a.last_date||''))).slice(0,20);
    $('guestResults').className='card-list'; show($('guestResults'));
    $('guestResults').innerHTML=rows.length?rows.map(x=>`<article class="guest-card"><h3>${esc(x.guest_name)}</h3><p>${esc(x.mobile)} • ${x.total_stays} stay(s)</p><p>Last room: ${x.last_room} • Last visit: ${x.last_date?dmy(x.last_date):'-'}</p><p>Total Rent: ${money(x.total_rent)}</p></article>`).join(''):'<div class="empty-state">No matching guest found.</div>';
  }

  $('reportMonth').value=new Date().toISOString().slice(0,7); $('printReport').onclick=()=>window.print();
  $('reportMonth').onchange=loadReport;
  async function loadReport(){ const m=$('reportMonth').value||new Date().toISOString().slice(0,7); const r=await sb.rpc('monthly_report',{p_month:m+'-01'}); if(r.error)return toast(r.error.message); const data=r.data||{}; $('reportSummary').innerHTML=`<div class="summary-card"><span>Total Stays</span><strong>${data.total_stays||0}</strong></div><div class="summary-card"><span>Total Rent (Rs.)</span><strong>${money(data.total_rent||0)}</strong></div>`; const rows=data.rooms||[]; $('roomReport').innerHTML=`<table class="report-table"><thead><tr><th>Room</th><th>Total Stays</th><th>Total Rent (Rs.)</th><th>Last Guest</th></tr></thead><tbody>${rows.map(x=>`<tr class="clickable ${selectedReportRoom===x.room_no?'selected':''}" data-report-room="${x.room_no}"><td>Room ${x.room_no}</td><td>${x.total_stays}</td><td>${money(x.total_rent)}</td><td>${esc(x.last_guest||'-')}</td></tr>`).join('')}<tr class="report-total"><td>Total</td><td>${data.total_stays||0}</td><td>${money(data.total_rent||0)}</td><td>-</td></tr></tbody></table>`; qsa('[data-report-room]').forEach(tr=>tr.onclick=()=>loadRoomDetail(Number(tr.dataset.reportRoom),m)); if(selectedReportRoom)loadRoomDetail(selectedReportRoom,m); }
  async function loadRoomDetail(room,m){ selectedReportRoom=room; $('detailReportTitle').textContent=`Room ${room} – Date-wise Report`; const r=await sb.rpc('room_month_detail',{p_room_no:room,p_month:m+'-01'}); if(r.error)return toast(r.error.message); const rows=r.data||[]; $('roomDetailReport').innerHTML=rows.length?`<table class="report-table"><thead><tr><th>Date</th><th>Guest Name</th><th>Mobile Number</th><th>Rent (Rs.)</th></tr></thead><tbody>${rows.map(x=>`<tr><td>${dmy(x.start_date)}</td><td>${esc(x.guest_name)}</td><td>${esc(x.mobile)}</td><td>${money(x.rent)}</td></tr>`).join('')}<tr class="report-total"><td colspan="3">Total (Room ${room})</td><td>${money(rows.reduce((a,x)=>a+Number(x.rent||0),0))}</td></tr></tbody></table>`:'<div class="empty-state">No stays for this room in the selected month.</div>'; loadReportHighlight(); }
  function loadReportHighlight(){ qsa('[data-report-room]').forEach(tr=>tr.classList.toggle('selected',Number(tr.dataset.reportRoom)===selectedReportRoom)); }

  $('menuBtn').onclick=()=>$('adminMenu').classList.toggle('hidden');
  document.addEventListener('click',e=>{ if(!e.target.closest('#menuBtn')&&!e.target.closest('#adminMenu')) hide($('adminMenu')); });
  $('logoutBtn').onclick=async()=>{ await sb.rpc('logout_app_account'); await sb.auth.signOut(); location.reload(); };
  $('lockBtn').onclick=()=>{ if(role()!=='admin')return; if(!locked){locked=true;localStorage.setItem('residency_locked','1');syncRoleUI();renderCalendar();toast('Admin editing locked');}else openUnlock(); };
  function openUnlock(){ openModal('Unlock Admin Editing',`<div class="form-grid"><label>Lock Password<input id="unlockPass" type="password"></label></div><div class="modal-actions"><button id="doUnlock" class="primary">Unlock</button></div>`); $('doUnlock').onclick=async()=>{ const r=await sb.rpc('verify_lock_password',{p_password:$('unlockPass').value}); if(r.error||!r.data)return toast('Incorrect lock password'); locked=false;localStorage.setItem('residency_locked','0');closeModal();syncRoleUI();renderCalendar();toast('Editing unlocked'); }; }

  async function openUserManagement(){
    if(!isMainAdmin()) return toast('Main Admin access required');
    const r=await sb.rpc('admin_list_users');
    if(r.error)return toast(r.error.message);
    const users=r.data||[];
    const regularAdmins=users.filter(u=>u.role==='admin'&&!u.is_owner).length;
    const viewers=users.filter(u=>u.role==='viewer').length;
    openModal('User & Device Management',`
      <div class="summary-cards" style="margin-bottom:14px">
        <div class="summary-card"><span>Main Admin</span><strong>1 / 1</strong></div>
        <div class="summary-card"><span>Managers</span><strong>${regularAdmins} / 2</strong></div>
        <div class="summary-card"><span>Viewers</span><strong>${viewers} / 2</strong></div>
      </div>
      <div id="usersList">${users.map(u=>`<div class="guest-card">
        <h3>${esc(u.username)} <small>• ${u.is_owner?'Main Admin':(u.role==='admin'?'Manager':'Viewer')}</small></h3>
        <p>${u.active_now?'🟢 Active':'⚪ Offline'}${u.last_seen_at?` • Last seen ${new Date(u.last_seen_at).toLocaleString()}`:''}</p>
        <p>Device: ${u.bound_device_name?esc(u.bound_device_name):'<em>Not registered</em>'}</p>
        ${u.is_owner?'<p>Main Admin account</p>':`<div class="modal-actions">
          <button class="neutral" data-edit-user="${u.id}" data-username="${esc(u.username)}">Change Login</button>
          <button class="neutral" data-role-id="${u.id}" data-new-role="${u.role==='admin'?'viewer':'admin'}">Make ${u.role==='admin'?'Viewer':'Manager'}</button>
          ${u.bound_device_id?`<button class="danger" data-remove-device="${u.id}">Remove Device</button>`:''}
          <button class="danger" data-block-id="${u.id}" data-block="${!u.is_blocked}">${u.is_blocked?'Unblock':'Block'}</button>
        </div>`}
      </div>`).join('')}</div>
      ${users.length<5?`<hr><h4>Create User</h4><div class="form-grid"><label>Username<input id="newUser"></label><label>Password<input id="newPass" type="password"></label><label>Role<select id="newRole">${viewers<2?'<option value="viewer">Viewer</option>':''}${regularAdmins<2?'<option value="admin">Manager</option>':''}</select></label></div><div class="modal-actions"><button id="createUser" class="primary">Create User</button></div>`:'<p><strong>Maximum 5 accounts reached.</strong></p>'}
    `);
    qsa('[data-role-id]').forEach(b=>b.onclick=async()=>{
      const x=await sb.rpc('admin_change_role',{p_account_id:b.dataset.roleId,p_new_role:b.dataset.newRole});
      if(x.error)return toast(x.error.message);
      toast('Role changed. That user must sign in again.');
      closeModal(); setTimeout(openUserManagement,150);
    });
    qsa('[data-block-id]').forEach(b=>b.onclick=async()=>{
      const x=await sb.rpc('admin_set_blocked',{p_account_id:b.dataset.blockId,p_blocked:b.dataset.block==='true'});
      if(x.error)return toast(x.error.message);
      toast('User status updated');
      closeModal(); setTimeout(openUserManagement,150);
    });
    qsa('[data-remove-device]').forEach(b=>b.onclick=()=>confirmAction('Remove this registered device? The user will be able to sign in on a new device only after this.',async()=>{
      const x=await sb.rpc('admin_remove_device',{p_account_id:b.dataset.removeDevice});
      if(x.error)return toast(x.error.message);
      toast('Device removed. New device login is now allowed.');
      closeModal(); setTimeout(openUserManagement,150);
    }));
    qsa('[data-edit-user]').forEach(b=>b.onclick=()=>{
      const id=b.dataset.editUser, current=b.dataset.username;
      openModal('Change User Login',`<p><strong>${esc(current)}</strong></p><div class="form-grid"><label>New Username (optional)<input id="manageUsername" placeholder="Leave blank to keep current"></label><label>New Password (optional)<input id="managePassword" type="password" placeholder="Leave blank to keep current"></label></div><div class="modal-actions"><button id="saveManagedLogin" class="primary">Save Changes</button></div>`);
      $('saveManagedLogin').onclick=async()=>{
        const x=await sb.rpc('admin_update_user_login',{p_account_id:id,p_new_username:$('manageUsername').value.trim()||null,p_new_password:$('managePassword').value||null});
        if(x.error)return toast(x.error.message);
        toast('User login updated. That user must sign in again.'); closeModal();
      };
    });
    if($('createUser')) $('createUser').onclick=async()=>{
      const x=await sb.rpc('admin_create_user',{p_username:$('newUser').value.trim(),p_password:$('newPass').value,p_role:$('newRole').value});
      if(x.error)return toast(x.error.message);
      toast('User created'); closeModal(); setTimeout(openUserManagement,150);
    };
  }
  $('usersBtn').onclick=openUserManagement;

  $('accountBtn').onclick=()=>{
    if(role()!=='admin')return;
    if(isMainAdmin()){
      openModal('Main Admin Account',`<div class="form-grid"><label>Current Password<input id="curPass" type="password"></label><label>New Username (optional)<input id="newUsername" placeholder="Leave blank to keep current"></label><label>New Password (optional)<input id="newAdminPass" type="password" placeholder="Leave blank to keep current"></label></div><div class="modal-actions"><button id="saveAdminAccount" class="primary">Save Changes</button></div>`);
    }else{
      openModal('Change My Password',`<div class="form-grid"><label>Current Password<input id="curPass" type="password"></label><label>New Password<input id="newAdminPass" type="password"></label></div><div class="modal-actions"><button id="saveAdminAccount" class="primary">Change Password</button></div>`);
    }
    $('saveAdminAccount').onclick=async()=>{
      const newUsername=isMainAdmin() ? ($('newUsername').value.trim()||null) : null;
      const newPassword=$('newAdminPass').value||null;
      const r=await sb.rpc('admin_change_my_login',{p_current_password:$('curPass').value,p_new_username:newUsername,p_new_password:newPassword});
      if(r.error)return toast(r.error.message);
      toast('Login updated. Please sign in again.'); setTimeout(()=>location.reload(),1000);
    };
  };
  $('lockPasswordBtn').onclick=()=>{
    if(!isMainAdmin())return toast('Main Admin access required');
    openModal('Change Lock Password',`<div class="form-grid"><label>Current Lock Password<input id="oldLock" type="password"></label><label>New Lock Password<input id="newLock" type="password"></label></div><div class="modal-actions"><button id="saveLockPassword" class="primary">Change Password</button></div>`);
    $('saveLockPassword').onclick=async()=>{ const r=await sb.rpc('admin_change_lock_password',{p_current_password:$('oldLock').value,p_new_password:$('newLock').value}); if(r.error)return toast(r.error.message); toast('Lock password changed');closeModal(); };
  };

  $('notifyBtn').onclick=registerPush;
  window.onNativeNotificationPermission=granted=>toast(granted?'Notifications enabled':'Notification permission was not granted.');
  async function registerServiceWorker(){ if('serviceWorker' in navigator){ try{ await navigator.serviceWorker.register('./sw.js',{scope:'./'}); }catch(_){ } } }
  function urlBase64ToUint8Array(base64String){ const padding='='.repeat((4-base64String.length%4)%4); const base64=(base64String+padding).replace(/-/g,'+').replace(/_/g,'/'); const raw=atob(base64); return Uint8Array.from([...raw].map(c=>c.charCodeAt(0))); }
  async function registerPush(){
    if(window.RESIDENCY_ANDROID && window.AndroidNative?.enableNotifications){
      try{ window.AndroidNative.enableNotifications(); }catch(e){ toast(e.message||'Could not enable notifications.'); }
      return;
    }
    if(!('Notification' in window)) return toast('Notifications are not supported in this app window.');
    if(Notification.permission==='denied') return toast('Notifications are blocked. Allow notifications for this app in browser/site settings.');
    try{
      const permission=await Notification.requestPermission(); if(permission!=='granted')return toast('Notification permission was not granted.');
      if(!('serviceWorker' in navigator)||!('PushManager' in window)) return toast('Notifications enabled while this app is open. Background push is not supported by this app window.');
      const reg=await navigator.serviceWorker.ready; let sub=await reg.pushManager.getSubscription();
      if(!sub) sub=await reg.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:urlBase64ToUint8Array(cfg.vapidPublicKey)});
      const r=await sb.from('push_subscriptions').upsert({auth_uid:authUser.id,device_id:deviceId,subscription:sub.toJSON(),device_name:deviceName},{onConflict:'auth_uid,device_id'});
      if(r.error)throw r.error; toast('Notifications enabled');
    }catch(e){toast(e.message||'Could not enable notifications.');}
  }

  boot();
})();
