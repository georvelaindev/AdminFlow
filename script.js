// Données partagées entre les différentes vues de l'application.
const state = {
    user: null,
    documents: [],
    requests: [],
    messages: [],
    announcements: [],
    notifications: [],
    users: []
};

let notificationsInitialized = false;
let latestNotificationId = 0;

const roleNames = {
    dg: 'Directeur Général (DG)',
    de: 'Directeur des Études (DE)',
    scolarite: 'Chef de Scolarité (CSS)',
    admin: 'Chef du système informatique',
    secretariat: 'Secrétariat Général (SG)'
};

// Initialise les formulaires, les événements et la session utilisateur.
document.addEventListener('DOMContentLoaded', initialize);

async function initialize() {
    document.getElementById('setup-form').addEventListener('submit', handleSetup);
    document.getElementById('login-form').addEventListener('submit', handleLogin);
    const searchInput = document.getElementById('global-search-input');
    searchInput.addEventListener('input', renderGlobalSearch);
    searchInput.addEventListener('keydown', handleGlobalSearchKeydown);
    document.getElementById('global-search-results').addEventListener('click', (event) => {
        const result = event.target.closest('button[data-search-type]');
        if (result) openGlobalSearchResult(result.dataset.searchType, result.dataset.searchId);
    });
    document.addEventListener('pointerdown', (event) => {
        if (!document.getElementById('global-search').contains(event.target)) closeGlobalSearch();
    });
    document.getElementById('form-new-doc').addEventListener('submit', handleNewDocument);
    const fileDropzone = document.getElementById('file-dropzone');
    const fileInput = document.getElementById('file-input');
    fileDropzone.addEventListener('dragover', (event) => {
        event.preventDefault();
        fileDropzone.classList.add('border-blue-500', 'bg-blue-50');
    });
    fileDropzone.addEventListener('dragleave', () => {
        fileDropzone.classList.remove('border-blue-500', 'bg-blue-50');
    });
    fileDropzone.addEventListener('drop', (event) => {
        event.preventDefault();
        fileDropzone.classList.remove('border-blue-500', 'bg-blue-50');
        const file = event.dataTransfer.files[0];
        if (!file) return;
        const transfer = new DataTransfer();
        transfer.items.add(file);
        fileInput.files = transfer.files;
        updateFileName(fileInput);
    });
    fileInput.addEventListener('change', () => updateFileName(fileInput));
    document.getElementById('form-new-demande').addEventListener('submit', handleNewDemande);
    document.getElementById('message-form').addEventListener('submit', handleNewMessage);
    document.getElementById('announcement-form').addEventListener('submit', handleNewAnnouncement);
    document.getElementById('user-form').addEventListener('submit', handleNewUser);
    document.getElementById('password-form').addEventListener('submit', handlePasswordChange);

    try {
        const status = await api('/api/status');
        if (status.setupRequired) {
            document.getElementById('setup-panel').classList.remove('hidden');
            return;
        }

        try {
            const result = await api('/api/me');
            await enterApplication(result.user);
        } catch (error) {
            if (error.status !== 401) throw error;
            showLogin();
        }
    } catch (error) {
        showAuthError(`Impossible de joindre le serveur : ${error.message}`);
    }
}

// Centralise les appels HTTP et la gestion des erreurs de l'API.
async function api(url, options = {}) {
    const response = await fetch(url, {
        credentials: 'same-origin',
        ...options,
        headers: {
            ...(options.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
            ...(options.headers || {})
        }
    });
    const contentType = response.headers.get('content-type') || '';
    const result = contentType.includes('application/json') ? await response.json() : null;
    if (!response.ok) {
        const error = new Error(result?.error || `Requête impossible (${response.status}).`);
        error.status = response.status;
        throw error;
    }
    return result;
}

// Affiche les formulaires de connexion et de configuration initiale.
function showLogin() {
    document.getElementById('setup-panel').classList.add('hidden');
    document.getElementById('login-panel').classList.remove('hidden');
    document.getElementById('auth-screen').classList.remove('hidden');
}

function showAuthError(message) {
    const error = document.getElementById('auth-error');
    error.textContent = message;
    error.classList.remove('hidden');
}

function clearAuthError() {
    const error = document.getElementById('auth-error');
    error.textContent = '';
    error.classList.add('hidden');
}

async function handleSetup(event) {
    event.preventDefault();
    clearAuthError();
    const form = event.currentTarget;
    const data = Object.fromEntries(new FormData(form));
    try {
        const result = await api('/api/setup', { method: 'POST', body: JSON.stringify(data) });
        await enterApplication(result.user);
    } catch (error) {
        showAuthError(error.message);
    }
}

async function handleLogin(event) {
    event.preventDefault();
    clearAuthError();
    const form = event.currentTarget;
    try {
        const result = await api('/api/login', {
            method: 'POST',
            body: JSON.stringify(Object.fromEntries(new FormData(form)))
        });
        form.reset();
        await enterApplication(result.user);
    } catch (error) {
        showAuthError(error.message);
    }
}

async function enterApplication(user) {
    state.user = user;
    state.notifications = [];
    notificationsInitialized = false;
    latestNotificationId = 0;
    document.getElementById('auth-screen').classList.add('hidden');
    document.getElementById('app-root').classList.remove('hidden');
    document.getElementById('user-display-name').textContent = user.name;
    setText('demande-requester-name', user.name);
    document.getElementById('user-display-role').textContent = roleNames[user.role];
    document.getElementById('user-avatar').textContent = user.name
        .split(/\s+/)
        .map((part) => part[0])
        .join('')
        .slice(0, 2)
        .toUpperCase();
    document.getElementById('dash-welcome-name').textContent = user.name;
    document.getElementById('role-banner-name').textContent = roleNames[user.role];
    document
        .querySelectorAll('.admin-only')
        .forEach((element) => element.classList.toggle('hidden', user.role !== 'admin'));
    document
        .getElementById('publish-announcement-button')
        .classList.toggle('hidden', !['dg', 'de', 'scolarite', 'admin', 'secretariat'].includes(user.role));
    showTab('dashboard');
    await refreshData();
    connectEvents();
}

async function logout() {
    try {
        await api('/api/logout', { method: 'POST', body: '{}' });
    } catch (error) {
        if (error.status !== 401) showToast(error.message, 'error');
    }
    state.user = null;
    notificationsInitialized = false;
    latestNotificationId = 0;
    if (window.adminFlowEvents) window.adminFlowEvents.close();
    document.getElementById('app-root').classList.add('hidden');
    showLogin();
}

async function refreshData() {
    try {
        const data = await api('/api/bootstrap');
        const incomingNotifications = notificationsInitialized
            ? data.notifications.filter((item) => Number(item.id) > latestNotificationId)
            : [];
        latestNotificationId = Math.max(
            latestNotificationId,
            ...data.notifications.map((item) => Number(item.id))
        );
        if (notificationsInitialized) {
            notifyIncomingNotifications(incomingNotifications);
        }
        Object.assign(state, data);
        notificationsInitialized = true;
        renderAll();
    } catch (error) {
        if (error.status === 401) {
            showLogin();
            document.getElementById('app-root').classList.add('hidden');
            return;
        }
        showToast(error.message, 'error');
    }
}

function connectEvents() {
    if (window.adminFlowEvents) window.adminFlowEvents.close();
    const events = new EventSource('/api/events');
    events.addEventListener('refresh', refreshData);
    events.onerror = () => {
        if (!state.user) events.close();
    };
    window.adminFlowEvents = events;
}

function renderAll() {
    renderDashboard();
    renderDocumentsTable();
    renderDemandesTable();
    renderMessages();
    renderAnnouncements();
    renderNotifications();
    renderUsers();
    updateNotificationCounts();
}

// Recherche globale dans les contenus accessibles à l'utilisateur.
function normalizeSearchText(value) {
    return String(value ?? '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLocaleLowerCase();
}

function renderGlobalSearch() {
    const input = document.getElementById('global-search-input');
    const results = document.getElementById('global-search-results');
    const query = normalizeSearchText(input.value.trim());
    if (!query) {
        results.innerHTML =
            '<p class="p-4 text-sm text-slate-500">Recherchez dans vos documents, demandes, messages et annonces.</p>';
        results.classList.add('hidden');
        input.setAttribute('aria-expanded', 'false');
        return;
    }

    const matches = [];
    for (const document of state.documents) {
        matches.push({
            type: 'document',
            id: document.id,
            tab: 'documents',
            title: document.title,
            detail: `${document.id} · ${document.file_name} · ${document.sender} · ${document.status}`,
            searchable: `${document.title} ${document.id} ${document.file_name} ${document.sender} ${document.category} ${document.status}`,
            time: document.created_at
        });
    }
    for (const request of state.requests) {
        matches.push({
            type: 'request',
            id: request.id,
            tab: 'demandes',
            title: request.object,
            detail: `${request.id} · ${request.student} · ${request.sender} · ${request.status}`,
            searchable: `${request.object} ${request.id} ${request.student} ${request.sender} ${request.status} ${request.priority}`,
            time: request.created_at
        });
    }
    for (const message of state.messages) {
        matches.push({
            type: 'message',
            id: message.id,
            tab: 'communication',
            title: message.body,
            detail: `${message.sender} · ${roleNames[message.sender_role]} · À : ${roleNames[message.receiver_role]}`,
            searchable: `${message.body} ${message.sender} ${roleNames[message.sender_role]} ${roleNames[message.receiver_role]}`,
            time: message.created_at
        });
    }
    for (const announcement of state.announcements) {
        matches.push({
            type: 'announcement',
            id: announcement.id,
            tab: 'annonces',
            title: announcement.title,
            detail: `${announcement.author} · ${announcement.body}`,
            searchable: `${announcement.title} ${announcement.body} ${announcement.author} ${announcement.priority}`,
            time: announcement.created_at
        });
    }
    for (const notification of state.notifications) {
        matches.push({
            type: 'notification',
            id: notification.id,
            tab: 'notifications',
            title: notification.title,
            detail: notification.text,
            searchable: `${notification.title} ${notification.text}`,
            time: notification.time
        });
    }

    const terms = query.split(/\s+/);
    const matched = matches
        .filter((item) => {
            const text = normalizeSearchText(`${item.title} ${item.detail} ${item.searchable}`);
            return terms.every((term) => text.includes(term));
        })
        .sort((a, b) => String(b.time).localeCompare(String(a.time)))
        .slice(0, 8);

    if (!matched.length) {
        results.innerHTML =
            '<p class="p-4 text-sm text-slate-500">Aucun résultat dans les éléments auxquels vous avez accès.</p>';
    } else {
        const labels = {
            document: 'Document',
            request: 'Demande',
            message: 'Message',
            announcement: 'Annonce',
            notification: 'Notification'
        };
        results.innerHTML = `
            <p class="border-b border-slate-100 px-4 py-2 text-xs text-slate-500">${matched.length} résultat${matched.length > 1 ? 's' : ''} · appuyez sur Entrée pour ouvrir le premier</p>
            <div class="p-1">${matched
                .map(
                    (item) => `
                <button type="button" role="option" data-search-type="${item.type}" data-search-id="${escapeAttr(item.id)}" class="block w-full rounded-lg px-3 py-2 text-left hover:bg-blue-50 focus:bg-blue-50 focus:outline-none">
                    <span class="flex items-center justify-between gap-3"><strong class="truncate text-sm text-slate-800">${escapeHtml(item.title)}</strong><span class="shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-[10px] text-slate-600">${labels[item.type]}</span></span>
                    <span class="mt-1 block truncate text-xs text-slate-500">${escapeHtml(item.detail)}</span>
                </button>`
                )
                .join('')}</div>`;
    }
    results.classList.remove('hidden');
    input.setAttribute('aria-expanded', 'true');
}

function handleGlobalSearchKeydown(event) {
    if (event.key === 'Escape') {
        closeGlobalSearch();
    } else if (event.key === 'Enter') {
        event.preventDefault();
        document.querySelector('#global-search-results button[data-search-type]')?.click();
    }
}

function closeGlobalSearch() {
    document.getElementById('global-search-results').classList.add('hidden');
    document.getElementById('global-search-input').setAttribute('aria-expanded', 'false');
}

function openGlobalSearchResult(type, id) {
    const tabs = {
        document: 'documents',
        request: 'demandes',
        message: 'communication',
        announcement: 'annonces',
        notification: 'notifications'
    };
    const tab = tabs[type];
    if (!tab) return;

    if (type === 'document') {
        document.getElementById('filter-category').value = 'all';
        document.getElementById('filter-status').value = 'all';
        document.getElementById('doc-search-input').value = '';
        renderDocumentsTable();
    }
    showTab(tab);
    document.getElementById('global-search-input').value = '';
    renderGlobalSearch();

    const result = [...document.querySelectorAll('[data-global-search-type]')].find(
        (element) =>
            element.dataset.globalSearchType === type && element.dataset.globalSearchId === String(id)
    );
    if (result) {
        result.scrollIntoView({ behavior: 'smooth', block: 'center' });
        result.classList.add('ring-2', 'ring-blue-500');
        window.setTimeout(() => result.classList.remove('ring-2', 'ring-blue-500'), 2000);
    }
}

// Fonctions de rendu des vues et des indicateurs de l'application.
function renderDashboard() {
    const total = state.documents.length;
    const pending = state.documents.filter((doc) => doc.status === 'En cours').length;
    const received = state.requests.filter((request) => request.receiver_role === state.user.role).length;
    const pendingReceived = state.requests.filter(
        (request) =>
            request.receiver_role === state.user.role && !['Terminé', 'Rejeté'].includes(request.status)
    ).length;
    const sent = state.requests.filter((request) => request.sender_id === state.user.id).length;
    setText('stat-total-docs', total);
    setText('chart-total-docs', total);
    setText('stat-pending-docs', pending);
    setText('stat-requests-received', received);
    setText('stat-requests-sent', sent);
    setText('badge-doc-count', pending);
    setText('badge-request-count', pendingReceived);
    const now = new Date();
    setText(
        'today-date',
        now.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
    );
    setText('today-time', now.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }));

    const recent = document.getElementById('recent-activity');
    const activities = [
        ...state.documents.slice(0, 4).map((doc) => ({
            icon: doc.status === 'Validé' ? 'fa-check' : 'fa-file-arrow-up',
            title: doc.status === 'Validé' ? 'Document validé' : 'Document transmis',
            detail: `${doc.title} — ${doc.sender}`,
            time: doc.created_at
        })),
        ...state.requests.slice(0, 2).map((request) => ({
            icon: 'fa-list-check',
            title: 'Demande administrative',
            detail: `${request.object} — ${request.sender}`,
            time: request.created_at
        }))
    ]
        .sort((a, b) => String(b.time).localeCompare(String(a.time)))
        .slice(0, 5);
    recent.innerHTML = activities.length
        ? activities
              .map(
                  (item) => `
        <div class="flex items-start gap-3">
            <div class="w-10 h-10 rounded-xl bg-blue-50 text-blue-600 flex items-center justify-center shrink-0"><i class="fa-solid ${item.icon}"></i></div>
            <div class="min-w-0 flex-1 border-b border-slate-100 pb-3">
                <div class="font-semibold text-slate-800">${escapeHtml(item.title)}</div>
                <div class="text-sm text-slate-500 break-words">${escapeHtml(item.detail)}</div>
                <div class="text-[11px] text-slate-400 mt-1">${escapeHtml(formatDate(item.time))}</div>
            </div>
        </div>`
              )
              .join('')
        : emptyState('Aucune activité pour le moment.');

    const counts = ['Validé', 'En cours', 'Rejeté'].map((status) => [
        status,
        state.documents.filter((doc) => doc.status === status).length
    ]);
    const colors = { Validé: 'bg-emerald-500', 'En cours': 'bg-amber-500', Rejeté: 'bg-red-500' };
    const totalByStatus = counts.reduce((total, [, count]) => total + count, 0);
    const validAngle = totalByStatus ? (counts[0][1] / totalByStatus) * 360 : 0;
    const pendingAngle = totalByStatus ? ((counts[0][1] + counts[1][1]) / totalByStatus) * 360 : 0;
    const rejectedAngle = totalByStatus
        ? ((counts[0][1] + counts[1][1] + counts[2][1]) / totalByStatus) * 360
        : 360;
    const chart = document.querySelector('#chart-total-docs')?.parentElement?.parentElement?.parentElement;
    if (chart)
        chart.style.background = totalByStatus
            ? `conic-gradient(#34d399 0 ${validAngle}deg, #fbbf24 ${validAngle}deg ${pendingAngle}deg, #ef4444 ${pendingAngle}deg ${rejectedAngle}deg)`
            : '#e2e8f0';
    document.getElementById('document-status-summary').innerHTML = counts
        .map(
            ([status, count]) => `
        <div class="flex items-center gap-2"><span class="w-3 h-3 rounded-full ${colors[status]}"></span>${escapeHtml(status)}<span class="ml-auto font-semibold text-slate-700">${count}</span></div>
    `
        )
        .join('');
    document.getElementById('recent-requests').innerHTML =
        state.requests
            .slice(0, 3)
            .map(
                (request) => `
        <div class="rounded-xl bg-slate-50 p-3">
            <div class="font-semibold text-slate-800">${escapeHtml(request.object)}</div>
            <div class="mt-1 flex justify-between text-xs text-slate-500"><span>${escapeHtml(request.status)}</span><span>${escapeHtml(formatDate(request.created_at))}</span></div>
        </div>`
            )
            .join('') || emptyState('Aucune demande.');
    document.getElementById('dashboard-notifications').innerHTML =
        state.notifications
            .slice(0, 3)
            .map(
                (notification) => `
        <button onclick="markNotificationRead(${Number(notification.id)})" class="w-full text-left flex items-start gap-3 rounded-xl ${notification.unread ? 'bg-blue-50' : 'bg-slate-50'} p-3">
            <span class="w-8 h-8 rounded-full bg-blue-100 text-blue-600 flex items-center justify-center shrink-0"><i class="fa-solid fa-bell"></i></span>
            <span class="min-w-0"><span class="block font-semibold text-slate-800">${escapeHtml(notification.title)}</span><span class="block text-xs text-slate-500 mt-1">${escapeHtml(notification.text)}</span></span>
        </button>`
            )
            .join('') || emptyState('Aucune notification.');
}

function renderDocumentsTable(documents = state.documents) {
    const tbody = document.getElementById('table-documents-body');
    if (!documents.length) {
        tbody.innerHTML =
            '<tr><td colspan="6" class="p-8 text-center text-slate-400">Aucun document disponible.</td></tr>';
        return;
    }
    tbody.innerHTML = documents
        .map((doc) => {
            const mayProcess = state.user.role === 'dg' || doc.receiver_role === state.user.role;
            return `<tr data-global-search-type="document" data-global-search-id="${escapeAttr(doc.id)}" class="hover:bg-slate-50/80">
            <td class="p-4"><div class="font-bold text-slate-800">${escapeHtml(doc.title)}</div><div class="text-[10px] text-slate-400 mt-1">${escapeHtml(doc.id)} · ${escapeHtml(doc.file_name)}</div></td>
            <td class="p-4">${escapeHtml(doc.category)}</td>
            <td class="p-4"><div class="text-slate-700">${escapeHtml(doc.sender)}</div><div class="text-[10px] text-blue-600">À : ${escapeHtml(roleNames[doc.receiver_role])}</div></td>
            <td class="p-4 text-slate-500">${escapeHtml(formatDate(doc.created_at))}</td>
            <td class="p-4">${getStatusBadge(doc.status)}</td>
            <td class="p-4 text-right space-x-1">
                <button onclick="viewHistory('${escapeAttr(doc.id)}')" class="p-1.5 text-slate-500 hover:text-blue-600" title="Historique"><i class="fa-solid fa-clock-rotate-left"></i></button>
                <a href="/api/documents/${encodeURIComponent(doc.id)}/file" target="_blank" rel="noopener" class="p-1.5 text-blue-600" title="Télécharger"><i class="fa-solid fa-download"></i></a>
                ${mayProcess && doc.status === 'En cours' ? `<button onclick="changeDocStatus('${escapeAttr(doc.id)}','Validé')" class="px-2 py-1 bg-emerald-600 text-white rounded text-[10px]">Valider</button><button onclick="changeDocStatus('${escapeAttr(doc.id)}','Rejeté')" class="px-2 py-1 bg-rose-100 text-rose-700 rounded text-[10px]">Rejeter</button>` : ''}
            </td>
        </tr>`;
        })
        .join('');
}

function renderDemandesTable() {
    const tbody = document.getElementById('table-demandes-body');
    document.getElementById('clear-requests-button').classList.toggle('hidden', state.requests.length === 0);
    tbody.innerHTML = state.requests.length
        ? state.requests
              .map((request) => {
                  const mayProcess = request.receiver_role === state.user.role;
                  const nextStatus = request.status === 'En attente' ? 'En traitement' : 'Terminé';
                  return `<tr data-global-search-type="request" data-global-search-id="${escapeAttr(request.id)}">
            <td class="p-4 font-bold text-slate-700">${escapeHtml(request.id)}</td>
            <td class="p-4">${escapeHtml(request.sender)}</td>
            <td class="p-4">${escapeHtml(request.object)}<div class="text-[10px] text-slate-400">Destinataire : ${escapeHtml(roleNames[request.receiver_role])}</div></td>
            <td class="p-4">${getPriorityBadge(request.priority)}</td>
            <td class="p-4"><span class="bg-blue-50 text-blue-700 px-2 py-1 rounded text-[10px]">${escapeHtml(request.status)}</span></td>
            <td class="p-4 text-right">
                ${mayProcess && !['Terminé', 'Rejeté'].includes(request.status) ? `<button onclick="updateRequestStatus('${escapeAttr(request.id)}','${nextStatus}')" class="text-blue-600 hover:underline font-bold">${request.status === 'En attente' ? 'Prendre en charge' : 'Terminer'}</button><button onclick="updateRequestStatus('${escapeAttr(request.id)}','Rejeté')" class="ml-2 text-red-600 hover:underline">Rejeter</button>` : ''}
                <button type="button" onclick="hideRequest('${escapeAttr(request.id)}')" class="ml-2 text-slate-400 hover:text-rose-600" title="Retirer de ma liste" aria-label="Retirer la demande ${escapeAttr(request.id)} de ma liste"><i class="fa-solid fa-trash-can"></i></button>
            </td>
        </tr>`;
              })
              .join('')
        : '<tr><td colspan="6" class="p-8 text-center text-slate-400">Aucune demande.</td></tr>';
}

function renderMessages() {
    const list = document.getElementById('messages-list');
    document.getElementById('clear-messages-button').classList.toggle('hidden', state.messages.length === 0);
    list.innerHTML = state.messages.length
        ? state.messages
              .map(
                  (message) => `
        <article data-global-search-type="message" data-global-search-id="${Number(message.id)}" class="rounded-xl border border-slate-200 p-4">
            <div class="flex justify-between gap-3 text-xs">
                <strong class="text-slate-800">${escapeHtml(message.sender)} · ${escapeHtml(roleNames[message.sender_role])}</strong>
                <div class="flex items-center gap-3">
                    <time class="text-slate-400">${escapeHtml(formatDate(message.created_at))}</time>
                    <button type="button" onclick="hideMessage(${Number(message.id)})" class="text-slate-400 hover:text-rose-600" title="Masquer ce message pour moi" aria-label="Masquer ce message pour moi"><i class="fa-solid fa-trash-can"></i></button>
                </div>
            </div>
            <p class="text-xs text-blue-700 mt-1">À : ${escapeHtml(roleNames[message.receiver_role])}</p>
            <p class="text-sm text-slate-700 mt-2 whitespace-pre-wrap break-words">${escapeHtml(message.body)}</p>
        </article>`
              )
              .join('')
        : emptyState('Aucun message dans votre boîte de service.');
    list.scrollTop = list.scrollHeight;
}

function renderAnnouncements() {
    const list = document.getElementById('announcements-list');
    document.getElementById('clear-announcements-button').classList.toggle('hidden', state.announcements.length === 0);
    list.innerHTML = state.announcements.length
        ? state.announcements
              .map(
                  (item) => `
        <article data-global-search-type="announcement" data-global-search-id="${Number(item.id)}" class="bg-white p-5 rounded-xl border border-slate-200 shadow-sm space-y-2">
            <div class="flex items-center justify-between gap-3">
                <span class="${item.priority === 'URGENT' ? 'bg-amber-100 text-amber-800' : 'bg-blue-100 text-blue-800'} text-[10px] font-bold px-2 py-1 rounded">${escapeHtml(item.priority)}</span>
                <button type="button" onclick="hideAnnouncement(${Number(item.id)})" class="text-slate-400 hover:text-rose-600" title="Retirer de ma liste" aria-label="Retirer l’annonce ${escapeAttr(item.title)} de ma liste"><i class="fa-solid fa-trash-can"></i></button>
            </div>
            <h3 class="font-bold text-slate-800">${escapeHtml(item.title)}</h3>
            <p class="text-sm text-slate-600 whitespace-pre-wrap">${escapeHtml(item.body)}</p>
            <p class="text-[10px] text-slate-400">Publié par ${escapeHtml(item.author)} · ${escapeHtml(formatDate(item.created_at))}</p>
        </article>`
              )
              .join('')
        : emptyState('Aucune annonce publiée.');
}

function renderNotifications() {
    const list = document.getElementById('notifications-list');
    document.getElementById('clear-notifications-button').classList.toggle('hidden', state.notifications.length === 0);
    list.innerHTML = state.notifications.length
        ? state.notifications
              .map(
                  (item) => `
        <article class="w-full p-4 rounded-xl border ${item.unread ? 'bg-blue-50 border-blue-200' : 'bg-white border-slate-200'} flex items-start gap-3 text-xs">
            <span class="w-8 h-8 rounded-full bg-blue-100 text-blue-600 flex items-center justify-center shrink-0"><i class="fa-solid fa-bell"></i></span>
            <button type="button" data-global-search-type="notification" data-global-search-id="${Number(item.id)}" onclick="markNotificationRead(${Number(item.id)})" class="flex-1 min-w-0 text-left">
                <span class="flex justify-between gap-3"><strong class="text-slate-800">${escapeHtml(item.title)}</strong><time class="text-[10px] text-slate-400">${escapeHtml(formatDate(item.time))}</time></span>
                <span class="block text-slate-600 mt-1">${escapeHtml(item.text)}</span>${item.unread ? '<span class="block text-blue-700 mt-2 font-semibold">Cliquer pour marquer comme lue</span>' : ''}
            </button>
            <button type="button" onclick="deleteNotification(${Number(item.id)})" class="shrink-0 text-slate-400 hover:text-rose-600" title="Supprimer cette notification" aria-label="Supprimer la notification ${escapeAttr(item.title)}"><i class="fa-solid fa-trash-can"></i></button>
        </article>`
              )
              .join('')
        : emptyState('Aucune notification.');
    renderDesktopNotificationControl();
}

function renderDesktopNotificationControl() {
    const status = document.getElementById('desktop-notification-status');
    const button = document.getElementById('enable-desktop-notifications');
    if (!('Notification' in window)) {
        status.textContent = 'Alertes de bureau non disponibles dans ce navigateur.';
        button.classList.add('hidden');
        return;
    }

    if (Notification.permission === 'granted') {
        status.textContent = 'Alertes de bureau activées.';
        button.classList.add('hidden');
    } else if (Notification.permission === 'denied') {
        status.textContent = 'Alertes bloquées par le navigateur. Modifiez ses autorisations de site.';
        button.classList.add('hidden');
    } else {
        status.textContent = 'Recevez une alerte lorsque la plateforme est ouverte.';
        button.classList.remove('hidden');
    }
}

async function enableDesktopNotifications() {
    if (!('Notification' in window)) {
        showToast('Les alertes de bureau ne sont pas disponibles dans ce navigateur.', 'error');
        return;
    }
    try {
        const permission = await Notification.requestPermission();
        renderDesktopNotificationControl();
        if (permission === 'granted') {
            showToast('Alertes de bureau activées.', 'success');
        } else if (permission === 'denied') {
            showToast(
                'Autorisation refusée. Vous pouvez la modifier dans les paramètres du navigateur.',
                'error'
            );
        }
    } catch (error) {
        showToast(`Impossible d’activer les alertes : ${error.message}`, 'error');
    }
}

function notifyIncomingNotifications(notifications) {
    const newest = notifications.slice(0, 3).reverse();
    for (const item of newest) {
        showToast(`${item.title} — ${item.text}`);
        if ('Notification' in window && Notification.permission === 'granted') {
            try {
                const desktopNotification = new Notification(item.title, {
                    body: item.text,
                    tag: `adminflow-${item.id}`
                });
                desktopNotification.onclick = () => {
                    window.focus();
                    showTab('notifications');
                    desktopNotification.close();
                };
            } catch (error) {
                showToast(`Alerte de bureau impossible : ${error.message}`, 'error');
            }
        }
    }
    if (notifications.length > newest.length) {
        showToast(`${notifications.length - newest.length} autres notifications reçues.`);
    }
}

function renderUsers() {
    const list = document.getElementById('users-list');
    const activeRoleCounts = state.users.reduce((counts, user) => {
        if (user.is_active) counts[user.role] = (counts[user.role] || 0) + 1;
        return counts;
    }, {});
    const duplicateRoles = Object.keys(activeRoleCounts).filter((role) => activeRoleCounts[role] > 1);
    const roleConflictNotice = document.getElementById('role-conflict-notice');
    roleConflictNotice.classList.toggle('hidden', duplicateRoles.length === 0);
    roleConflictNotice.textContent = duplicateRoles.length
        ? `Rôles attribués à plusieurs comptes actifs : ${duplicateRoles.map((role) => roleNames[role]).join(', ')}. Désactivez un des comptes concernés.`
        : '';
    const roleSelect = document.querySelector('#user-form [name="role"]');
    roleSelect.innerHTML =
        '<option value="" selected disabled>Choisir un rôle disponible</option>' +
        Object.entries(roleNames)
            .map(([role, name]) => {
                const occupied = state.users.some((user) => user.role === role && user.is_active);
                return `<option value="${role}" ${occupied ? 'disabled' : ''}>${escapeHtml(name)}${occupied ? ' (déjà attribué)' : ''}</option>`;
            })
            .join('');
    if (state.user.role !== 'admin') {
        list.innerHTML =
            '<p class="py-2 text-slate-500">La gestion des comptes est réservée à l’administrateur.</p>';
        return;
    }
    list.innerHTML = state.users
        .map(
            (user) => `
        <div class="py-3 flex justify-between items-center gap-3">
            <div class="min-w-0">
                <p class="font-bold text-slate-800">${escapeHtml(user.name)}</p>
                <p class="text-slate-500">${escapeHtml(user.email)}</p>
            </div>
            <div class="flex items-center gap-2 shrink-0">
                <span class="bg-blue-50 text-blue-800 px-2 py-1 rounded font-semibold">${escapeHtml(roleNames[user.role])}</span>
                ${
                    user.is_active
                        ? user.id === state.user.id
                            ? '<span class="text-slate-400">Votre compte</span>'
                            : `<button type="button" onclick="deactivateUser(${Number(user.id)})" class="text-rose-600 hover:text-rose-800" title="Désactiver ce compte" aria-label="Désactiver le compte de ${escapeAttr(user.name)}"><i class="fa-solid fa-trash-can"></i></button>`
                        : '<span class="bg-slate-100 text-slate-500 px-2 py-1 rounded font-semibold">Désactivé</span><button type="button" onclick="activateUser(' +
                          Number(user.id) +
                          ')" class="text-emerald-700 hover:text-emerald-900" title="Réactiver ce compte" aria-label="Réactiver le compte de ' +
                          escapeAttr(user.name) +
                          '"><i class="fa-solid fa-user-check"></i></button>'
                }
            </div>
        </div>
    `
        )
        .join('');
}

// Mise à jour des compteurs, navigation et gestion des formulaires.
function updateNotificationCounts() {
    const count = state.notifications.filter((item) => item.unread).length;
    const header = document.getElementById('header-notification-count');
    const sidebar = document.getElementById('sidebar-notification-count');
    for (const badge of [header, sidebar]) {
        badge.textContent = String(count);
        badge.classList.toggle('hidden', count === 0);
        badge.classList.toggle('flex', badge === header && count > 0);
    }
}

function getStatusBadge(status) {
    const classes = {
        Validé: 'bg-emerald-50 text-emerald-700 border-emerald-200',
        'En cours': 'bg-amber-50 text-amber-700 border-amber-200',
        Rejeté: 'bg-rose-50 text-rose-700 border-rose-200'
    };
    return `<span class="inline-flex border ${classes[status] || 'bg-slate-100 text-slate-600 border-slate-200'} font-semibold px-2.5 py-0.5 rounded-full text-[10px]">${escapeHtml(status)}</span>`;
}

function getPriorityBadge(priority) {
    const classes =
        priority === 'Urgent'
            ? 'bg-rose-100 text-rose-800'
            : priority === 'Important'
              ? 'bg-amber-100 text-amber-800'
              : 'bg-slate-100 text-slate-600';
    return `<span class="${classes} font-bold px-2 py-1 rounded text-[10px]">${escapeHtml(priority)}</span>`;
}

function showTab(tabId) {
    document.querySelectorAll('.tab-content').forEach((tab) => tab.classList.add('hidden'));
    document.querySelectorAll('.nav-item').forEach((button) => {
        button.classList.remove('bg-blue-600', 'text-white');
        button.classList.add('text-slate-400');
    });
    document.getElementById(`tab-${tabId}`)?.classList.remove('hidden');
    const nav = document.getElementById(`nav-${tabId}`);
    if (nav) {
        nav.classList.add('bg-blue-600', 'text-white');
        nav.classList.remove('text-slate-400');
    }
    if (window.innerWidth < 1024) {
        const sidebar = document.getElementById('sidebar');
        if (sidebar && !sidebar.classList.contains('-translate-x-full')) toggleSidebar();
    }
}

function toggleSidebar() {
    if (window.innerWidth >= 1024) return;
    const sidebar = document.getElementById('sidebar');
    const overlay = document.getElementById('sidebar-overlay');
    if (!sidebar || !overlay) return;
    sidebar.classList.toggle('-translate-x-full');
    overlay.classList.toggle('hidden');
}

function openModal(id) {
    document.getElementById(id)?.classList.remove('hidden');
}

function closeModal(id) {
    document.getElementById(id)?.classList.add('hidden');
}

function updateFileName(input) {
    const file = input.files?.[0];
    input.setCustomValidity(
        file && file.size > 15 * 1024 * 1024 ? 'Le fichier dépasse la limite de 15 Mo.' : ''
    );
    setText('file-chosen-name', file ? `Fichier sélectionné : ${file.name}` : '');
}

// Actions métier : documents, demandes, messages, annonces et comptes.
async function handleNewDocument(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const formData = new FormData();
    formData.set('title', document.getElementById('doc-title').value);
    formData.set('category', document.getElementById('doc-category').value);
    formData.set('receiverRole', document.getElementById('doc-receiver').value);
    formData.set('notes', document.getElementById('doc-notes').value);
    const file = document.getElementById('file-input').files[0];
    if (file) formData.set('attachment', file);
    try {
        await api('/api/documents', { method: 'POST', body: formData });
        form.reset();
        updateFileName(document.getElementById('file-input'));
        closeModal('modal-new-doc');
        await refreshData();
        showToast('Document téléversé et transmis au destinataire.', 'success');
    } catch (error) {
        showToast(error.message, 'error');
    }
}

async function changeDocStatus(id, status) {
    try {
        await api(`/api/documents/${encodeURIComponent(id)}/status`, {
            method: 'PATCH',
            body: JSON.stringify({ status })
        });
        await refreshData();
        showToast(`Document mis à jour : ${status}.`, 'success');
    } catch (error) {
        showToast(error.message, 'error');
    }
}

function viewHistory(id) {
    const doc = state.documents.find((item) => item.id === id);
    if (!doc) return;
    const container = document.getElementById('history-content');
    container.innerHTML = `<div class="mb-3 bg-slate-50 p-3 rounded-lg border"><p class="font-bold">${escapeHtml(doc.title)}</p><p class="text-slate-500 mt-1">Réf : ${escapeHtml(doc.id)} · ${escapeHtml(doc.sender)}</p></div><div class="relative border-l-2 border-blue-500 ml-4 space-y-4 pl-4">${doc.history.map((item) => `<div class="relative"><span class="absolute -left-[21px] top-0 w-3 h-3 rounded-full bg-blue-600 ring-4 ring-white"></span><strong>${escapeHtml(item.step)}</strong><div>${escapeHtml(item.user)}</div><div class="text-[10px] text-slate-400 mt-1">${escapeHtml(formatDate(item.date))} · ${escapeHtml(item.status)}</div></div>`).join('')}</div>`;
    openModal('modal-history');
}

function applyDocFilters() {
    const category = document.getElementById('filter-category').value;
    const status = document.getElementById('filter-status').value;
    const search = document.getElementById('doc-search-input').value.trim().toLocaleLowerCase();
    renderDocumentsTable(
        state.documents.filter(
            (doc) =>
                (category === 'all' || doc.category === category) &&
                (status === 'all' || doc.status === status) &&
                `${doc.title} ${doc.id} ${doc.sender}`.toLocaleLowerCase().includes(search)
        )
    );
}

async function handleNewDemande(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = {
        object: document.getElementById('demande-object').value.trim(),
        priority: document.getElementById('demande-priority').value,
        receiverRole: document.getElementById('demande-receiver').value
    };
    if (!data.object) {
        showToast('Saisissez l’objet de la demande.', 'error');
        document.getElementById('demande-object').focus();
        return;
    }
    try {
        await api('/api/requests', { method: 'POST', body: JSON.stringify(data) });
        form.reset();
        closeModal('modal-new-demande');
        await refreshData();
        showToast('Demande transmise au service choisi.', 'success');
    } catch (error) {
        showToast(error.message, 'error');
    }
}

async function updateRequestStatus(id, status) {
    try {
        await api(`/api/requests/${encodeURIComponent(id)}/status`, {
            method: 'PATCH',
            body: JSON.stringify({ status })
        });
        await refreshData();
        showToast('Statut de la demande mis à jour.', 'success');
    } catch (error) {
        showToast(error.message, 'error');
    }
}

async function handleNewMessage(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = Object.fromEntries(new FormData(form));
    try {
        await api('/api/messages', { method: 'POST', body: JSON.stringify(data) });
        form.reset();
        await refreshData();
        showToast('Message transmis au service.', 'success');
    } catch (error) {
        showToast(error.message, 'error');
    }
}

async function removeFromMyList(endpoint, confirmation, successMessage) {
    if (!window.confirm(confirmation)) return;
    try {
        await api(endpoint, { method: 'DELETE' });
        await refreshData();
        showToast(successMessage, 'success');
    } catch (error) {
        showToast(error.message, 'error');
    }
}

function hideMessage(id) {
    return removeFromMyList(
        `/api/messages/${encodeURIComponent(id)}`,
        'Retirer ce message de votre boîte ? Les autres destinataires le verront toujours.',
        'Message retiré de votre boîte.'
    );
}

function clearMessages() {
    return removeFromMyList(
        '/api/messages',
        'Retirer tous les messages de votre boîte ? Ils resteront visibles par les autres destinataires.',
        'Messages retirés de votre boîte.'
    );
}

function hideRequest(id) {
    return removeFromMyList(
        `/api/requests/${encodeURIComponent(id)}`,
        'Retirer cette demande de votre liste ? Elle restera visible par les autres personnes concernées.',
        'Demande retirée de votre liste.'
    );
}

function clearRequests() {
    return removeFromMyList(
        '/api/requests',
        'Retirer toutes les demandes de votre liste ? Elles resteront visibles par les autres personnes concernées.',
        'Demandes retirées de votre liste.'
    );
}

function hideAnnouncement(id) {
    return removeFromMyList(
        `/api/announcements/${id}`,
        'Retirer cette annonce de votre liste ? Elle restera visible par les autres utilisateurs.',
        'Annonce retirée de votre liste.'
    );
}

function clearAnnouncements() {
    return removeFromMyList(
        '/api/announcements',
        'Retirer toutes les annonces de votre liste ? Elles resteront visibles par les autres utilisateurs.',
        'Annonces retirées de votre liste.'
    );
}

function deleteNotification(id) {
    return removeFromMyList(
        `/api/notifications/${id}`,
        'Supprimer cette notification de votre compte ?',
        'Notification supprimée.'
    );
}

function clearNotifications() {
    return removeFromMyList(
        '/api/notifications',
        'Supprimer toutes les notifications de votre compte ?',
        'Notifications supprimées.'
    );
}

function toggleAnnouncementForm() {
    document.getElementById('announcement-form').classList.toggle('hidden');
}

async function handleNewAnnouncement(event) {
    event.preventDefault();
    const form = event.currentTarget;
    try {
        await api('/api/announcements', {
            method: 'POST',
            body: JSON.stringify(Object.fromEntries(new FormData(form)))
        });
        form.reset();
        form.classList.add('hidden');
        await refreshData();
        showToast('Annonce publiée.', 'success');
    } catch (error) {
        showToast(error.message, 'error');
    }
}

async function handleNewUser(event) {
    event.preventDefault();
    const form = event.currentTarget;
    try {
        await api('/api/users', {
            method: 'POST',
            body: JSON.stringify(Object.fromEntries(new FormData(form)))
        });
        form.reset();
        await refreshData();
        showToast('Compte créé. Communiquez son mot de passe temporaire de manière sécurisée.', 'success');
    } catch (error) {
        showToast(error.message, 'error');
    }
}

async function deactivateUser(id) {
    const user = state.users.find((item) => Number(item.id) === id);
    if (!user || !user.is_active || id === Number(state.user.id)) return;
    if (
        !window.confirm(
            `Désactiver le compte de ${user.name} ? Ses messages, documents et demandes resteront conservés.`
        )
    )
        return;
    try {
        await api(`/api/users/${encodeURIComponent(id)}`, { method: 'DELETE' });
        await refreshData();
        showToast('Compte désactivé. Les historiques ont été conservés.', 'success');
    } catch (error) {
        showToast(error.message, 'error');
    }
}

async function activateUser(id) {
    const user = state.users.find((item) => Number(item.id) === id);
    if (!user || user.is_active) return;
    try {
        await api(`/api/users/${encodeURIComponent(id)}/activate`, { method: 'PATCH', body: '{}' });
        await refreshData();
        showToast('Compte réactivé. Son utilisateur pourra se reconnecter.', 'success');
    } catch (error) {
        showToast(error.message, 'error');
    }
}

async function handlePasswordChange(event) {
    event.preventDefault();
    const form = event.currentTarget;
    try {
        await api('/api/password', {
            method: 'POST',
            body: JSON.stringify(Object.fromEntries(new FormData(form)))
        });
        form.reset();
        showToast('Mot de passe mis à jour. Les autres sessions ont été déconnectées.', 'success');
    } catch (error) {
        showToast(error.message, 'error');
    }
}

async function markNotificationRead(id) {
    const notification = state.notifications.find((item) => item.id === id);
    if (!notification?.unread) return;
    try {
        await api(`/api/notifications/${id}/read`, { method: 'POST', body: '{}' });
        await refreshData();
    } catch (error) {
        showToast(error.message, 'error');
    }
}

// Petits utilitaires partagés par les vues et les formulaires.
function formatDate(value) {
    if (!value) return '';
    const date = new Date(value.includes('T') ? value : `${value.replace(' ', 'T')}Z`);
    return Number.isNaN(date.getTime())
        ? value
        : date.toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });
}

function emptyState(message) {
    return `<p class="py-4 text-center text-sm text-slate-400">${escapeHtml(message)}</p>`;
}

function setText(id, value) {
    const element = document.getElementById(id);
    if (element) element.textContent = String(value);
}

function escapeHtml(value) {
    return String(value ?? '').replace(
        /[&<>"']/g,
        (character) =>
            ({
                '&': '&amp;',
                '<': '&lt;',
                '>': '&gt;',
                '"': '&quot;',
                "'": '&#39;'
            })[character]
    );
}

function escapeAttr(value) {
    return escapeHtml(value).replaceAll('`', '&#96;');
}

function showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    if (!container) return;
    const toast = document.createElement('div');
    const color = type === 'success' ? 'bg-emerald-600' : type === 'error' ? 'bg-rose-600' : 'bg-slate-900';
    toast.className = `px-4 py-3 rounded-xl shadow-xl text-xs font-semibold text-white ${color} pointer-events-auto`;
    toast.textContent = message;
    container.appendChild(toast);
    window.setTimeout(() => toast.remove(), 4500);
}
