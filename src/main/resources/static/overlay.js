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
        notes: document.getElementById('notes'),
        statusLine: document.getElementById('statusLine'),
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
        el.overlay.addEventListener('click', (ev) => {
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

    function placeNoteAt(n) {
        const id = crypto.randomUUID();
        const text = prompt('Note text:', '');
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

        // Notes re-position (DOM elements)
        for (const n of notes.values()) {
            const p = toScreen(vidRect, n.nx, n.ny);
            n.el.style.left = p.x + 'px';
            n.el.style.top = p.y + 'px';
        }

        requestAnimationFrame(renderLoop);
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
    function upsertNote(id, nx, ny, text) {
        if (!id) return;
        let n = notes.get(id);
        if (!n) {
            const div = document.createElement('div');
            div.className = 'note';

            const actions = document.createElement('span');
            actions.className = 'actions';

            const copy = document.createElement('span');
            copy.className = 'action copy';
            copy.title = 'Copy to clipboard';
            copy.textContent = '⧉';
            copy.addEventListener('pointerdown', (e) => e.stopPropagation());
            copy.addEventListener('click', (e) => {
                e.stopPropagation();
                const cur = notes.get(id);
                if (!cur) return;
                const value = cur.text || '';
                if (navigator.clipboard && navigator.clipboard.writeText) {
                    navigator.clipboard.writeText(value).catch(() => fallbackCopy(value));
                } else {
                    fallbackCopy(value);
                }
                flashAction(copy);
            });

            const close = document.createElement('span');
            close.className = 'action close';
            close.title = 'Remove note';
            close.textContent = '✕';
            close.addEventListener('pointerdown', (e) => e.stopPropagation());
            close.addEventListener('click', (e) => {
                e.stopPropagation();
                send({ type: 'note_delete', noteId: id, userId: myId });
                removeNote(id);
            });

            actions.appendChild(copy);
            actions.appendChild(close);

            const body = document.createElement('span');
            body.className = 'body';

            div.appendChild(actions);
            div.appendChild(body);
            div.addEventListener('click', (e) => {
                if (e.target.closest('.action')) return;
                div.classList.toggle('opaque');
            });
            makeDraggable(div, id);
            el.notes.appendChild(div);
            n = { nx, ny, text, el: div, body };
            notes.set(id, n);
        } else {
            n.nx = nx; n.ny = ny; n.text = text;
        }
        n.body = n.el.querySelector('.body');
        n.body.textContent = text;
        n.nx = nx; n.ny = ny;
    }

    function fallbackCopy(value) {
        try {
            const ta = document.createElement('textarea');
            ta.value = value;
            ta.style.position = 'fixed';
            ta.style.opacity = '0';
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            ta.remove();
        } catch (_) {}
    }

    function flashAction(node) {
        node.classList.add('flash');
        setTimeout(() => node.classList.remove('flash'), 350);
    }

    function removeNote(id) {
        const n = notes.get(id);
        if (!n) return;
        try { n.el.remove(); } catch {}
        notes.delete(id);
    }

    function makeDraggable(div, id) {
        let dragging = false, startNx = 0, startNy = 0, startX = 0, startY = 0;
        div.addEventListener('pointerdown', (ev) => {
            if (ev.target.closest('.action')) return;
            dragging = true;
            div.setPointerCapture(ev.pointerId);
            const n = notes.get(id); if (!n) return;
            startNx = n.nx; startNy = n.ny;
            startX = ev.clientX; startY = ev.clientY;
            div.style.cursor = 'grabbing';
        });
        div.addEventListener('pointermove', (ev) => {
            if (!dragging) return;
            const vr = videoRect(); if (!vr) return;
            const n = notes.get(id); if (!n) return;
            const dx = (ev.clientX - startX) / vr.dw;
            const dy = (ev.clientY - startY) / vr.dh;
            n.nx = clamp01(startNx + dx);
            n.ny = clamp01(startNy + dy);
        });
        div.addEventListener('pointerup', (ev) => {
            if (!dragging) return;
            dragging = false;
            div.style.cursor = 'grab';
            const n = notes.get(id); if (!n) return;
            send({
                type: 'note',
                userId: myId, userName: myName,
                noteId: id, nx: n.nx, ny: n.ny, text: n.text,
            });
        });
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
