(() => {
  'use strict';

  const cfg = window.RESIDENCY_CONFIG || {};
  if (!window.supabase || !cfg.supabaseUrl || !cfg.supabasePublishableKey) return;

  const patchClient = window.supabase.createClient(cfg.supabaseUrl, cfg.supabasePublishableKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false }
  });

  let running = false;
  let queued = false;

  function showPatchToast(message) {
    const t = document.getElementById('toast');
    if (!t) return;
    t.textContent = message;
    t.classList.remove('hidden');
    setTimeout(() => t.classList.add('hidden'), 2600);
  }

  function todayISO() {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  function schedule() {
    if (queued) return;
    queued = true;
    setTimeout(() => {
      queued = false;
      syncCheckInUI();
    }, 120);
  }

  async function syncCheckInUI() {
    if (running) return;
    running = true;
    try {
      const cards = [...document.querySelectorAll('.cell-card[data-stay]')];
      const ids = [...new Set(cards.map(c => c.dataset.stay).filter(Boolean))];
      if (!ids.length) return;

      const { data, error } = await patchClient
        .from('stays')
        .select('id,status,room_no,start_date,end_date,guest_name')
        .in('id', ids);
      if (error || !data) return;

      const byId = new Map(data.map(x => [String(x.id), x]));

      // Any checked-in/active stay is shown in yellow so it is immediately obvious.
      for (const card of cards) {
        const stay = byId.get(String(card.dataset.stay));
        if (!stay) continue;
        const active = stay.status === 'active';
        card.classList.toggle('checked-in-active', active);
        if (active) {
          const label = card.querySelector('.cell-status');
          if (label) label.textContent = 'Check-In';
        }
      }

      const selected = document.querySelector('.cell-card.selected-cell[data-stay]');
      if (!selected) return;
      const selectedStay = byId.get(String(selected.dataset.stay));
      if (!selectedStay) return;

      const panel = document.getElementById('selectedDetails');
      if (!panel || panel.classList.contains('hidden')) return;

      const existingCheckIn = panel.querySelector('#checkInStay');
      const markAvailable = panel.querySelector('#markAvailable');

      if (selectedStay.status === 'reserved') {
        // Reserved/Booked: Check-In must occupy the old Mark Available position.
        if (existingCheckIn) existingCheckIn.remove();
        if (markAvailable) {
          const checkButton = markAvailable.cloneNode(true);
          markAvailable.replaceWith(checkButton);
          checkButton.id = 'patchCheckIn';
          checkButton.textContent = 'Check-In';
          checkButton.className = 'checkin-action';
          checkButton.onclick = async (e) => {
            e.preventDefault();
            e.stopPropagation();
            checkButton.disabled = true;
            try {
              const { data: fresh, error: freshError } = await patchClient
                .from('stays')
                .select('*')
                .eq('id', selectedStay.id)
                .single();
              if (freshError || !fresh) throw freshError || new Error('Booking not found.');

              const today = todayISO();
              const { data: clash, error: clashError } = await patchClient
                .from('stays')
                .select('id')
                .eq('room_no', Number(fresh.room_no))
                .lte('start_date', today)
                .gte('end_date', today)
                .in('status', ['reserved', 'active'])
                .neq('id', fresh.id)
                .limit(1);
              if (clashError) throw clashError;
              if (clash && clash.length) {
                showPatchToast(`Room ${fresh.room_no} is already booked today.`);
                return;
              }

              const newEnd = fresh.end_date < today ? today : fresh.end_date;
              const { error: updateError } = await patchClient
                .from('stays')
                .update({ status: 'active', end_date: newEnd })
                .eq('id', fresh.id);
              if (updateError) throw updateError;

              document.querySelectorAll(`.cell-card[data-stay="${fresh.id}"]`).forEach(card => {
                card.classList.add('checked-in-active');
                card.classList.remove('booked', 'continue');
                card.classList.add('checkin');
                const label = card.querySelector('.cell-status');
                if (label) label.textContent = 'Check-In';
              });
              showPatchToast(`Room ${fresh.room_no} checked in`);
              schedule();
            } catch (err) {
              const msg = String(err?.message || err || 'Could not check in.');
              showPatchToast(msg.includes('no_room_overlap') ? `Room ${selectedStay.room_no} is already booked today.` : msg);
            } finally {
              checkButton.disabled = false;
            }
          };
        }
      } else if (selectedStay.status === 'active') {
        // After Check-In, normal Mark Available returns for checkout/freeing the room.
        if (existingCheckIn) existingCheckIn.remove();
      }
    } finally {
      running = false;
    }
  }

  const observer = new MutationObserver(schedule);
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
  document.addEventListener('click', () => setTimeout(schedule, 80), true);
  setInterval(schedule, 2200);
  schedule();
})();
