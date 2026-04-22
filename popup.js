chrome.runtime.sendMessage({ type: 'LIST_STORED_HOSTS' }, function (hosts) {
    const box = document.getElementById('hosts');
    if (!hosts || hosts.length === 0) {
        box.innerHTML = '<div class="empty">（沒有暫存）</div>';
        return;
    }
    box.innerHTML = '';
    hosts.forEach(function (h) {
        const div = document.createElement('div');
        div.className = 'item';
        const mins = Math.floor(h.expiresIn / 60000);
        const secs = Math.floor((h.expiresIn % 60000) / 1000);
        div.innerHTML = '<div>' + h.host + '</div>' +
            '<small>剩餘 ' + mins + ' 分 ' + secs + ' 秒</small>';
        box.appendChild(div);
    });
});
