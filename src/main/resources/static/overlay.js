// InstantPear overlay page — runs as host (in plugin JCEF) or guest (browser).
(() => {
    const path = location.pathname;
    const role = path.startsWith('/host/') ? 'host' : 'guest';
    const lobbyCode = decodeURIComponent(path.split('/')[2] || '');
    const qp = new URLSearchParams(location.search);
    const presetName = qp.get('name') || '';
    const presetKey = qp.get('key') || '';

    const useSockJs = qp.get('sockjs') === '1';
    const wsUrl = useSockJs
        ? (location.protocol + '//' + location.host + '/sockjs')
        : ((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');

    const el = {
        setup: document.getElementById('setup'),
        role: document.getElementById('setup-role'),
        name: document.getElementById('nameInput'),
        keyRow: document.getElementById('keyRow'),
        key: document.getElementById('keyInput'),
        joinBtn: document.getElementById('joinBtn'),
        setupStatus: document.getElementById('setupStatus'),
        stage: document.getElementById('stage'),
        video: document.getElementById('video'),
        overlay: document.getElementById('overlay'),
        statusLine: document.getElementById('statusLine'),
        noteModalBackdrop: document.getElementById('noteModalBackdrop'),
        noteModalText: document.getElementById('noteModalText'),
        noteModalOk: document.getElementById('noteModalOk'),
        noteModalCancel: document.getElementById('noteModalCancel'),
        noteBtn: document.getElementById('noteBtn'),
        myNotesBtn: document.getElementById('myNotesBtn'),
        myNotesPanel: document.getElementById('myNotesPanel'),
        myNotesList: document.getElementById('myNotesList'),
        leaveBtn: document.getElementById('leaveBtn'),
        perfBar: document.getElementById('perfBar'),
        fpsSel: document.getElementById('fpsSel'),
        scaleSel: document.getElementById('scaleSel'),
        brSel: document.getElementById('brSel'),
    };
    el.role.textContent = role === 'host' ? 'Host mode — pick a display' : `Guest — lobby ${lobbyCode}`;
    el.name.value = presetName;
    el.key.value = presetKey;
    el.keyRow.hidden = false;
    if (role === 'host') el.joinBtn.textContent = 'Pick display & share';

    let ws, myId, hostId;
    let displayStream;             // host only
    const peers = new Map();       // userId -> RTCPeerConnection
    const remoteCursors = new Map(); // userId -> {nx, ny, name, color, tLast}
    const notes = new Map();       // noteId -> {nx, ny, text, el}  (guest view of others' notes — unused; stream renders them)
    const myNotes = new Map();     // noteId -> {nx, ny, text}      (notes placed by this user)
    const clickBlips = [];         // {nx, ny, t0, color}
    const hints = [];              // {nx, ny, text, t0}
    let myColor = '#3b82f6';
    let myName = 'Guest';
    let captureW = 0, captureH = 0; // host capture native dimensions

    el.joinBtn.addEventListener('click', () => {
        myName = el.name.value.trim() || (role === 'host' ? 'Host' : 'Guest');
        const key = el.key.value;
        el.setupStatus.textContent = 'Connecting...';
        el.setupStatus.classList.remove('err');

        if (role === 'host') {
            startHost(key).catch(err => {
                el.setupStatus.textContent = 'Host start failed: ' + err.message;
                el.setupStatus.classList.add('err');
            });
        } else {
            startGuest(key);
        }
    });

    el.leaveBtn?.addEventListener('click', () => {
        try { ws?.close(); } catch (_) {}
        for (const pc of peers.values()) try { pc.close(); } catch (_) {}
        if (displayStream) for (const t of displayStream.getTracks()) t.stop();
        location.reload();
    });

    // ── Host ──────────────────────────────────────────────────────────────
    async function startHost(key) {
        const fps = parseInt(el.fpsSel?.value || '30', 10);
        displayStream = await navigator.mediaDevices.getDisplayMedia({
            video: { frameRate: { ideal: fps, max: fps } },
            audio: false,
        });
        const videoTrack = displayStream.getVideoTracks()[0];
        const settings = videoTrack.getSettings();
        captureW = settings.width || 1920;
        captureH = settings.height || 1080;
        videoTrack.addEventListener('ended', () => {
            el.statusLine.textContent = 'Capture stopped';
            try { ws?.close(); } catch (_) {}
        });
        try { await videoTrack.applyConstraints({ frameRate: { ideal: fps, max: fps } }); } catch (_) {}

        connectWs();
        wsAddEventListener('open', () => {
            send({
                type: 'join_lobby',
                lobbyCode,
                lobbyKey: key,
                userName: myName,
            });
        });
    }

    // ── Guest ─────────────────────────────────────────────────────────────
    function startGuest(key) {
        connectWs();
        wsAddEventListener('open', () => {
            send({
                type: 'join_lobby',
                lobbyCode,
                lobbyKey: key,
                userName: myName,
            });
        });
    }

    // ── WebSocket plumbing ────────────────────────────────────────────────
    function connectWs() {
        if (useSockJs) {
            if (typeof window.SockJS !== 'function') {
                el.setupStatus.textContent = 'SockJS client not loaded';
                el.setupStatus.classList.add('err');
                return;
            }
            const s = new window.SockJS(wsUrl);
            ws = s;
            s.onopen = () => dispatch('open');
            s.onmessage = (ev) => onWsMessage(ev);
            s.onclose = () => {
                el.statusLine.textContent = 'Disconnected';
                dispatch('close');
            };
            s.onerror = () => {
                el.setupStatus.textContent = 'SockJS error';
                el.setupStatus.classList.add('err');
            };
        } else {
            ws = new WebSocket(wsUrl);
            ws.addEventListener('message', onWsMessage);
            ws.addEventListener('close', () => {
                el.statusLine.textContent = 'Disconnected';
            });
            ws.addEventListener('error', () => {
                el.setupStatus.textContent = 'WebSocket error';
                el.setupStatus.classList.add('err');
            });
        }
    }

    // Minimal ad-hoc event delegator so the same addEventListener('open',…)
    // calls further down work regardless of transport.
    const _wsListeners = { open: [], close: [] };
    function dispatch(name) {
        for (const fn of _wsListeners[name] || []) {
            try { fn(); } catch (_) {}
        }
    }

    function wsAddEventListener(name, fn) {
        if (useSockJs) {
            (_wsListeners[name] ||= []).push(fn);
        } else {
            ws.addEventListener(name, fn);
        }
    }

    function send(msg) {
        if (!ws) return;
        if (useSockJs) {
            try { ws.send(JSON.stringify(msg)); } catch (_) {}
        } else {
            if (ws.readyState !== 1) return;
            ws.send(JSON.stringify(msg));
        }
    }

    function onWsMessage(ev) {
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }
        switch (msg.type) {
            case 'lobby_created':
            case 'lobby_joined':
                myId = msg.userId;
                myColor = hashColor(myId);
                showStage();
                el.statusLine.textContent = role === 'host'
                    ? `Hosting ${lobbyCode}`
                    : `Joined ${lobbyCode} — waiting for stream`;
                if (role === 'host' && captureW && captureH) {
                    // announce display size so the plugin observer can size overlay
                    send({
                        type: 'capture_info',
                        userId: myId,
                        captureWidth: captureW,
                        captureHeight: captureH,
                    });
                }
                if (role === 'guest') {
                    send({ type: 'webrtc_ready', userId: myId, userName: myName });
                }
                break;

            case 'user_joined':
                // Do not open a WebRTC peer to plugin observers — they consume
                // only annotations over the WS channel, not media.
                if (role === 'host' && msg.userId && msg.observer !== true) {
                    offerTo(msg.userId);
                }
                break;

            case 'user_left':
                if (msg.userId) {
                    const pc = peers.get(msg.userId);
                    if (pc) { try { pc.close(); } catch {} peers.delete(msg.userId); }
                    remoteCursors.delete(msg.userId);
                    el.statusLine.textContent = `${msg.userName || 'User'} left`;
                }
                break;

            case 'webrtc_ready':
                // optional: guest announces itself; host already offers on user_joined
                break;

            case 'webrtc_offer':
                if (role === 'guest' && msg.userId) handleOffer(msg);
                break;

            case 'webrtc_answer':
                if (role === 'host' && msg.userId) handleAnswer(msg);
                break;

            case 'webrtc_ice':
                handleIce(msg);
                break;

            case 'cursor':
                if (msg.userId && msg.userId !== myId) {
                    remoteCursors.set(msg.userId, {
                        nx: msg.nx, ny: msg.ny,
                        name: msg.userName || 'Guest',
                        color: msg.color || '#3b82f6',
                        tLast: performance.now(),
                    });
                }
                break;

            case 'click':
                clickBlips.push({
                    nx: msg.nx, ny: msg.ny, t0: performance.now(),
                    color: msg.color || '#3b82f6',
                });
                break;

            case 'note':
                upsertNote(msg.noteId, msg.nx, msg.ny, msg.text || '');
                // If someone (host overlay) moved/edited one of our notes,
                // keep our local copy in sync for the My Notes panel.
                if (msg.noteId && myNotes.has(msg.noteId)) {
                    myNotes.set(msg.noteId, {
                        nx: msg.nx, ny: msg.ny, text: msg.text || '',
                    });
                    refreshMyNotesPanel();
                }
                break;

            case 'note_delete':
                removeNote(msg.noteId);
                if (msg.noteId && myNotes.delete(msg.noteId)) refreshMyNotesPanel();
                break;

            case 'hint':
                hints.push({ nx: msg.nx, ny: msg.ny, text: msg.text || '', t0: performance.now() });
                break;

            case 'error':
                el.setupStatus.textContent = 'Server: ' + (msg.message || 'error');
                el.setupStatus.classList.add('err');
                break;
        }
    }

    // ── WebRTC ────────────────────────────────────────────────────────────
    function iceServers() {
        const servers = [{ urls: 'stun:stun.l.google.com:19302' }];
        const turnUrl = qp.get('turnUrl');
        if (turnUrl) {
            const entry = { urls: turnUrl };
            const u = qp.get('turnUser'); if (u) entry.username = u;
            const p = qp.get('turnPass'); if (p) entry.credential = p;
            servers.push(entry);
        }
        return servers;
    }

    function makePc(peerId) {
        const pc = new RTCPeerConnection({ iceServers: iceServers() });
        pc.addEventListener('icecandidate', (e) => {
            if (e.candidate) {
                send({
                    type: 'webrtc_ice',
                    userId: myId,
                    targetUserId: peerId,
                    candidate: e.candidate.candidate,
                    sdpMid: e.candidate.sdpMid,
                    sdpMLineIndex: e.candidate.sdpMLineIndex,
                });
            }
        });
        pc.addEventListener('track', (e) => {
            if (role === 'guest' && e.streams[0]) {
                el.video.srcObject = e.streams[0];
                el.statusLine.textContent = 'Stream live';
            }
        });
        peers.set(peerId, pc);
        return pc;
    }

    async function offerTo(peerId) {
        const pc = makePc(peerId);
        for (const track of displayStream.getTracks()) {
            pc.addTrack(track, displayStream);
        }
        await applyEncodingParams(pc);
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        send({
            type: 'webrtc_offer',
            userId: myId,
            targetUserId: peerId,
            sdp: offer.sdp,
            sdpType: offer.type,
        });
    }

    async function handleOffer(msg) {
        hostId = msg.userId;
        const pc = makePc(msg.userId);
        await pc.setRemoteDescription({ type: msg.sdpType || 'offer', sdp: msg.sdp });
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        send({
            type: 'webrtc_answer',
            userId: myId,
            targetUserId: msg.userId,
            sdp: answer.sdp,
            sdpType: answer.type,
        });
    }

    async function handleAnswer(msg) {
        const pc = peers.get(msg.userId);
        if (!pc) return;
        await pc.setRemoteDescription({ type: msg.sdpType || 'answer', sdp: msg.sdp });
    }

    async function handleIce(msg) {
        const pc = peers.get(msg.userId);
        if (!pc || !msg.candidate) return;
        try {
            await pc.addIceCandidate({
                candidate: msg.candidate,
                sdpMid: msg.sdpMid,
                sdpMLineIndex: msg.sdpMLineIndex,
            });
        } catch (_) {}
    }

    // ── UI (guest annotation input, both-role rendering) ─────────────────
    function showStage() {
        el.setup.hidden = true;
        el.stage.hidden = false;
        if (role === 'host') {
            // Use captured stream as local preview
            el.video.srcObject = displayStream;
            el.perfBar.hidden = false;
            wireHostPerfControls();
        }
        fitCanvas();
        window.addEventListener('resize', fitCanvas);
        requestAnimationFrame(renderLoop);

        if (role === 'guest') {
            wireGuestInput();
        }
    }

    function wireHostPerfControls() {
        const apply = async () => {
            const fps = parseInt(el.fpsSel.value, 10);
            try {
                const track = displayStream?.getVideoTracks()[0];
                if (track) await track.applyConstraints({ frameRate: { ideal: fps, max: fps } });
            } catch (_) {}
            for (const pc of peers.values()) {
                await applyEncodingParams(pc);
            }
        };
        el.fpsSel.addEventListener('change', apply);
        el.scaleSel.addEventListener('change', apply);
        el.brSel.addEventListener('change', apply);
    }

    async function applyEncodingParams(pc) {
        const fps = parseInt(el.fpsSel?.value || '30', 10);
        const scale = parseFloat(el.scaleSel?.value || '1');
        const maxBitrate = parseInt(el.brSel?.value || '4000000', 10);
        for (const sender of pc.getSenders()) {
            if (!sender.track || sender.track.kind !== 'video') continue;
            try {
                const params = sender.getParameters();
                if (!params.encodings || params.encodings.length === 0) {
                    params.encodings = [{}];
                }
                params.encodings[0].maxBitrate = maxBitrate;
                params.encodings[0].maxFramerate = fps;
                params.encodings[0].scaleResolutionDownBy = scale;
                await sender.setParameters(params);
            } catch (e) { /* senders before setLocalDescription can reject */ }
        }
    }

    function fitCanvas() {
        const rect = el.overlay.getBoundingClientRect();
        el.overlay.width = rect.width * devicePixelRatio;
        el.overlay.height = rect.height * devicePixelRatio;
    }

    let noteMode = false;
    let draggingNoteId = null;
    let dragCenterOffsetX = 0;
    let dragCenterOffsetY = 0;
    let dragSuppressClick = false;
    let lastDragSend = 0;

    function wireGuestInput() {
        el.noteBtn.addEventListener('click', () => {
            noteMode = !noteMode;
            el.noteBtn.classList.toggle('active', noteMode);
        });

        el.myNotesBtn.addEventListener('click', () => {
            el.myNotesPanel.hidden = !el.myNotesPanel.hidden;
            if (!el.myNotesPanel.hidden) renderMyNotesList();
        });

        let lastCursorSend = 0;
        el.overlay.addEventListener('mousemove', (ev) => {
            const now = performance.now();
            if (now - lastCursorSend < 33) return;
            lastCursorSend = now;
            const n = normalize(ev);
            if (!n) return;
            send({
                type: 'cursor',
                userId: myId, userName: myName, color: myColor,
                nx: n.x, ny: n.y,
            });
        });

        el.overlay.addEventListener('pointerdown', (ev) => {
            if (ev.button !== 0) return; // only left-button starts a drag
            const overlayRect = el.overlay.getBoundingClientRect();
            const px = ev.clientX - overlayRect.left;
            const py = ev.clientY - overlayRect.top;
            const hit = hitTestNote(px, py);
            if (!hit) return;
            draggingNoteId = hit.id;
            dragCenterOffsetX = px - hit.rect.cx;
            dragCenterOffsetY = py - hit.rect.cy;
            dragSuppressClick = true;
            try { el.overlay.setPointerCapture(ev.pointerId); } catch (_) {}
            ev.preventDefault();
        });

        el.overlay.addEventListener('pointermove', (ev) => {
            if (!draggingNoteId) return;
            const vr = videoRect();
            if (!vr) return;
            const overlayRect = el.overlay.getBoundingClientRect();
            const px = ev.clientX - overlayRect.left;
            const py = ev.clientY - overlayRect.top;
            const cx = px - dragCenterOffsetX;
            const cy = py - dragCenterOffsetY;
            const nx = clamp01((cx - vr.ox) / vr.dw);
            const ny = clamp01((cy - vr.oy) / vr.dh);
            const n = notes.get(draggingNoteId);
            if (!n) return;
            n.nx = nx; n.ny = ny;
            if (myNotes.has(draggingNoteId)) {
                myNotes.set(draggingNoteId, { nx, ny, text: n.text });
                if (!el.myNotesPanel.hidden) renderMyNotesList();
            }
            const now = performance.now();
            if (now - lastDragSend >= 50) {
                lastDragSend = now;
                send({
                    type: 'note',
                    userId: myId, userName: myName,
                    noteId: draggingNoteId, nx, ny, text: n.text || '',
                });
            }
        });

        const endDrag = (ev) => {
            if (!draggingNoteId) return;
            const id = draggingNoteId;
            draggingNoteId = null;
            try { el.overlay.releasePointerCapture(ev.pointerId); } catch (_) {}
            const n = notes.get(id);
            if (!n) return;
            send({
                type: 'note',
                userId: myId, userName: myName,
                noteId: id, nx: n.nx, ny: n.ny, text: n.text || '',
            });
        };
        el.overlay.addEventListener('pointerup', endDrag);
        el.overlay.addEventListener('pointercancel', endDrag);

        el.overlay.addEventListener('click', (ev) => {
            if (dragSuppressClick) { dragSuppressClick = false; return; }
            const n = normalize(ev);
            if (!n) return;
            if (noteMode) {
                placeNoteAt(n);
                noteMode = false;
                el.noteBtn.classList.remove('active');
            } else {
                send({
                    type: 'click',
                    userId: myId, userName: myName,
                    color: myColor,
                    nx: n.x, ny: n.y,
                });
            }
        });

        // Right-click places a sticky note at the cursor — suppresses the
        // browser context menu.
        el.overlay.addEventListener('contextmenu', (ev) => {
            ev.preventDefault();
            const n = normalize(ev);
            if (!n) return;
            placeNoteAt(n);
        });
    }

    async function placeNoteAt(n) {
        const id = crypto.randomUUID();
        const text = await openNoteModal('');
        if (text === null) return;
        send({
            type: 'note',
            userId: myId, userName: myName,
            noteId: id, nx: n.x, ny: n.y, text,
        });
        // Track locally so the creator can list/remove their own notes.
        // The note itself is rendered by the host overlay, captured in the
        // video stream — no DOM duplication on the guest side.
        myNotes.set(id, { nx: n.x, ny: n.y, text });
        refreshMyNotesPanel();
    }

    /**
     * Multi-line note input via a styled textarea modal. Returns the entered
     * text (newlines preserved) or null if the user cancelled.
     */
    function openNoteModal(initial) {
        return new Promise((resolve) => {
            el.noteModalText.value = initial || '';
            el.noteModalBackdrop.hidden = false;
            // Defer focus so the modal has time to lay out.
            setTimeout(() => el.noteModalText.focus(), 0);

            const cleanup = () => {
                el.noteModalBackdrop.hidden = true;
                el.noteModalOk.removeEventListener('click', onOk);
                el.noteModalCancel.removeEventListener('click', onCancel);
                el.noteModalText.removeEventListener('keydown', onKey);
                el.noteModalBackdrop.removeEventListener('mousedown', onBackdrop);
            };
            const onOk = () => { const t = el.noteModalText.value; cleanup(); resolve(t); };
            const onCancel = () => { cleanup(); resolve(null); };
            const onKey = (ev) => {
                if (ev.key === 'Escape') { ev.preventDefault(); onCancel(); }
                else if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) {
                    ev.preventDefault();
                    onOk();
                }
                // plain Enter falls through and inserts a newline.
            };
            const onBackdrop = (ev) => {
                if (ev.target === el.noteModalBackdrop) onCancel();
            };

            el.noteModalOk.addEventListener('click', onOk);
            el.noteModalCancel.addEventListener('click', onCancel);
            el.noteModalText.addEventListener('keydown', onKey);
            el.noteModalBackdrop.addEventListener('mousedown', onBackdrop);
        });
    }

    function refreshMyNotesPanel() {
        const count = myNotes.size;
        el.myNotesBtn.hidden = count === 0;
        el.myNotesBtn.textContent = `My notes (${count})`;
        if (el.myNotesPanel.hidden) return;
        renderMyNotesList();
    }

    function renderMyNotesList() {
        el.myNotesList.innerHTML = '';
        if (myNotes.size === 0) {
            const e = document.createElement('div');
            e.className = 'empty';
            e.textContent = 'No notes yet.';
            el.myNotesList.appendChild(e);
            return;
        }
        for (const [id, n] of myNotes) {
            const row = document.createElement('div');
            row.className = 'entry';
            const t = document.createElement('span');
            t.className = 'text';
            t.textContent = n.text || '(empty)';
            const rm = document.createElement('button');
            rm.className = 'remove';
            rm.textContent = 'Remove';
            rm.addEventListener('click', () => {
                send({ type: 'note_delete', noteId: id, userId: myId });
                myNotes.delete(id);
                refreshMyNotesPanel();
            });
            row.appendChild(t);
            row.appendChild(rm);
            el.myNotesList.appendChild(row);
        }
    }

    function normalize(ev) {
        // Normalize against the displayed video rect, not the raw element.
        const vr = el.video.getBoundingClientRect();
        const vw = el.video.videoWidth;
        const vh = el.video.videoHeight;
        if (!vw || !vh) {
            // fall back to overlay-relative coords (host preview during startup)
            const r = el.overlay.getBoundingClientRect();
            return { x: (ev.clientX - r.left) / r.width, y: (ev.clientY - r.top) / r.height };
        }
        // Compute object-fit: contain letterbox
        const scale = Math.min(vr.width / vw, vr.height / vh);
        const dw = vw * scale, dh = vh * scale;
        const ox = vr.left + (vr.width - dw) / 2;
        const oy = vr.top + (vr.height - dh) / 2;
        const x = (ev.clientX - ox) / dw;
        const y = (ev.clientY - oy) / dh;
        if (x < 0 || y < 0 || x > 1 || y > 1) return null;
        return { x, y };
    }

    // ── Render loop ──────────────────────────────────────────────────────
    function renderLoop() {
        const ctx = el.overlay.getContext('2d');
        ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
        const r = el.overlay.getBoundingClientRect();
        ctx.clearRect(0, 0, r.width, r.height);

        const vidRect = videoRect();
        if (!vidRect) { requestAnimationFrame(renderLoop); return; }

        const now = performance.now();

        // Click blips (colored by author)
        for (let i = clickBlips.length - 1; i >= 0; i--) {
            const b = clickBlips[i];
            const age = now - b.t0;
            if (age > 1000) { clickBlips.splice(i, 1); continue; }
            const p = toScreen(vidRect, b.nx, b.ny);
            const t = age / 1000;
            ctx.beginPath();
            ctx.arc(p.x, p.y, 10 + t * 40, 0, Math.PI * 2);
            ctx.strokeStyle = hexToRgba(b.color || '#3b82f6', 1 - t);
            ctx.lineWidth = 3;
            ctx.stroke();
        }

        // Hints
        for (let i = hints.length - 1; i >= 0; i--) {
            const h = hints[i];
            const age = now - h.t0;
            if (age > 2500) { hints.splice(i, 1); continue; }
            const p = toScreen(vidRect, h.nx, h.ny);
            const alpha = 1 - age / 2500;
            ctx.fillStyle = `rgba(250,204,21,${alpha})`;
            ctx.font = '13px system-ui';
            ctx.fillText(h.text, p.x + 12, p.y - 12);
        }

        // Remote cursors
        for (const [uid, c] of remoteCursors) {
            if (now - c.tLast > 10000) { remoteCursors.delete(uid); continue; }
            const p = toScreen(vidRect, c.nx, c.ny);
            drawCursor(ctx, p.x, p.y, c.color, c.name);
        }

        // During a guest-initiated drag, render a local ghost of the note so
        // the mover sees immediate feedback — the video stream catches up a
        // few frames later.
        if (role === 'guest' && draggingNoteId) {
            const n = notes.get(draggingNoteId);
            if (n) drawNotePreview(ctx, vidRect, n);
        }

        requestAnimationFrame(renderLoop);
    }

    function drawNotePreview(ctx, vr, note) {
        ctx.save();
        const r = noteScreenRect(vr, note, ctx);
        ctx.fillStyle = 'rgba(250, 204, 21, 0.55)';
        ctx.strokeStyle = 'rgba(250, 204, 21, 1)';
        ctx.lineWidth = 2;
        roundRect(ctx, r.x, r.y, r.w, r.h, 8);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = '#111';
        ctx.font = '13px sans-serif';
        ctx.textBaseline = 'top';
        const lineHeight = 16;
        const lines = (note.text || '').split('\n').map((l) => truncateFor(ctx, l, 220));
        for (let i = 0; i < lines.length; i++) {
            ctx.fillText(lines[i], r.x + 10, r.y + 6 + i * lineHeight);
        }
        ctx.textBaseline = 'alphabetic';
        ctx.restore();
    }

    function roundRect(ctx, x, y, w, h, radius) {
        const r = Math.min(radius, w / 2, h / 2);
        ctx.beginPath();
        ctx.moveTo(x + r, y);
        ctx.arcTo(x + w, y, x + w, y + h, r);
        ctx.arcTo(x + w, y + h, x, y + h, r);
        ctx.arcTo(x, y + h, x, y, r);
        ctx.arcTo(x, y, x + w, y, r);
        ctx.closePath();
    }

    function truncateFor(ctx, text, maxPx) {
        if (ctx.measureText(text).width <= maxPx) return text;
        const ell = '...';
        let lo = 0, hi = text.length;
        while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (ctx.measureText(text.slice(0, mid) + ell).width <= maxPx) lo = mid;
            else hi = mid - 1;
        }
        return text.slice(0, lo) + ell;
    }

    // Approximate the host overlay's note rectangle in screen (canvas) space
    // so the guest can hit-test against it. Dimensions mirror the Java panel
    // draw logic in OverlayWindow.kt — including multi-line text height.
    function noteScreenRect(vr, note, ctx) {
        const padX = 10, padY = 6, textMaxW = 220, lineHeight = 16;
        const prevFont = ctx.font;
        ctx.font = '13px sans-serif';
        const lines = (note.text || '').split('\n');
        const maxLineW = lines.reduce(
            (m, l) => Math.max(m, ctx.measureText(l).width),
            0,
        );
        ctx.font = prevFont;
        const tw = Math.min(maxLineW, textMaxW);
        const textBlockH = Math.max(1, lines.length) * lineHeight;
        const w = Math.round(tw + padX * 2);
        const h = Math.max(Math.round(textBlockH + padY * 2), 18 + padY * 2);
        const sx = vr.ox + note.nx * vr.dw;
        const sy = vr.oy + note.ny * vr.dh;
        return { x: Math.round(sx - w / 2), y: Math.round(sy - h / 2), w, h, cx: sx, cy: sy };
    }

    function hitTestNote(px, py) {
        const vr = videoRect();
        if (!vr) return null;
        const ctx = el.overlay.getContext('2d');
        // Iterate in reverse insertion order so top-most wins visually.
        const ids = Array.from(notes.keys()).reverse();
        for (const id of ids) {
            const n = notes.get(id);
            const r = noteScreenRect(vr, n, ctx);
            if (px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h) {
                return { id, rect: r };
            }
        }
        return null;
    }

    function videoRect() {
        const vr = el.video.getBoundingClientRect();
        const vw = el.video.videoWidth;
        const vh = el.video.videoHeight;
        if (!vw || !vh) return null;
        const scale = Math.min(vr.width / vw, vr.height / vh);
        const dw = vw * scale, dh = vh * scale;
        const ox = (vr.width - dw) / 2;
        const oy = (vr.height - dh) / 2;
        return { ox, oy, dw, dh };
    }

    function toScreen(vr, nx, ny) {
        return { x: vr.ox + nx * vr.dw, y: vr.oy + ny * vr.dh };
    }

    function drawCursor(ctx, x, y, color, name) {
        ctx.save();
        ctx.translate(x, y);
        ctx.fillStyle = color;
        ctx.strokeStyle = '#000';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(0, 16);
        ctx.lineTo(4, 12);
        ctx.lineTo(9, 20);
        ctx.lineTo(11, 18);
        ctx.lineTo(6, 10);
        ctx.lineTo(12, 10);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        ctx.font = '12px system-ui';
        ctx.fillStyle = '#000';
        ctx.fillRect(14, -4, ctx.measureText(name).width + 8, 16);
        ctx.fillStyle = '#fff';
        ctx.fillText(name, 18, 8);
        ctx.restore();
    }

    // ── Notes (DOM elements) ─────────────────────────────────────────────
    // Data-only — DOM rendering of notes on the guest was removed so the
    // host overlay (captured in the video stream) is the sole visual source.
    // The Map is used for hit-testing during guest-driven drag.
    function upsertNote(id, nx, ny, text) {
        if (!id) return;
        const existing = notes.get(id);
        if (existing) {
            existing.nx = nx; existing.ny = ny; existing.text = text;
        } else {
            notes.set(id, { nx, ny, text });
        }
    }

    function removeNote(id) {
        notes.delete(id);
    }

    function clamp01(v) { return Math.max(0, Math.min(1, v)); }

    function hexToRgba(hex, alpha) {
        const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
        if (!m) return `rgba(59,130,246,${alpha})`;
        return `rgba(${parseInt(m[1],16)},${parseInt(m[2],16)},${parseInt(m[3],16)},${alpha})`;
    }

    function hashColor(id) {
        const palette = [
            '#f97316', '#3b82f6', '#10b981', '#a855f7',
            '#ef4444', '#14b8a6', '#eab308', '#ec4899',
            '#22d3ee', '#f87171', '#84cc16', '#c084fc',
        ];
        let h = 2166136261 >>> 0;
        for (let i = 0; i < (id || '').length; i++) {
            h ^= id.charCodeAt(i);
            h = Math.imul(h, 16777619) >>> 0;
        }
        return palette[h % palette.length];
    }
})();
