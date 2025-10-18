// script.js

const form = document.getElementById('dns-form');
const domainInput = document.getElementById('domain');
const typeInput = document.getElementById('type');
const resultsDisplay = document.getElementById('results-display');
const submitButton = document.getElementById('submit-button');
const buttonText = submitButton.querySelector('.button-text');
const spinner = submitButton.querySelector('.spinner');

// DNS 类型数字到字符串的映射
const dnsTypeMap = {
    1: 'A', 2: 'NS', 5: 'CNAME', 6: 'SOA', 12: 'PTR', 15: 'MX',
    16: 'TXT', 28: 'AAAA', 33: 'SRV', 43: 'DS', 46: 'RRSIG',
    48: 'DNSKEY', 52: 'TLSA', 65: 'HTTPS', 257: 'CAA', 32769: 'DLV'
};

// 控制按钮加载状态的函数
const setLoadingState = (isLoading) => {
    submitButton.disabled = isLoading;
    buttonText.style.display = isLoading ? 'none' : 'inline-block';
    spinner.style.display = isLoading ? 'inline-block' : 'none';
};

// 格式化 TTL (Time To Live)
const formatTTL = (seconds) => {
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
    return `${Math.floor(seconds / 86400)}d`;
};

// 格式化 DNS 响应为人类可读的 HTML
const formatDnsResponse = (data) => {
    // 检查 DoH 状态码
    // Status: 0=NOERROR, 1=FORMERR, 2=SERVFAIL, 3=NXDOMAIN, etc.
    if (data.Status !== 0) {
        let message = `查询失败。状态: ${data.Status}`;
        if (data.Status === 3) message = `域名不存在 (NXDOMAIN)。`;
        if (data.Status === 2) message = `服务器错误 (SERVFAIL)。`;
        resultsDisplay.className = 'warning';
        return `<p class="status-message warning">${message}</p>`;
    }

    if (!data.Answer || data.Answer.length === 0) {
        resultsDisplay.className = 'warning';
        return `<p class="status-message warning">未找到该类型的记录。</p>`;
    }
    
    resultsDisplay.className = 'success';
    
    // 构建表头
    const header = `
        <div class="results-header">
            <div class="col-name">名称</div>
            <div class="col-ttl">TTL</div>
            <div class="col-type">类型</div>
            <div class="col-data">数据</div>
        </div>
    `;

    // 构建每一条记录
    const records = data.Answer.map(record => {
        const typeStr = dnsTypeMap[record.type] || `TYPE${record.type}`;
        let dataStr = record.data;

        // 对特定类型进行美化
        switch (typeStr) {
            case 'MX': {
                const parts = record.data.split(' ');
                dataStr = `<span class="record-part"><strong>优先级:</strong> ${parts[0]}</span> <span class="record-part">${parts[1]}</span>`;
                break;
            }
            case 'SRV': {
                 const parts = record.data.split(' ');
                 dataStr = `
                    <span class="record-part"><strong>优先级:</strong> ${parts[0]}</span>
                    <span class="record-part"><strong>权重:</strong> ${parts[1]}</span>
                    <span class="record-part"><strong>端口:</strong> ${parts[2]}</span>
                    <span class="record-part">${parts[3]}</span>
                 `;
                break;
            }
            case 'CAA': {
                const parts = record.data.split(' ');
                const tag = parts[1];
                const value = parts[2].replace(/"/g, ''); // 移除引号
                dataStr = `<span class="record-part"><strong>标记:</strong> ${parts[0]}</span> <span class="record-part">${tag}</span> <span class="record-part">"${value}"</span>`;
                break;
            }
            case 'TXT':
                // 移除两端的引号，方便阅读
                dataStr = record.data.replace(/^"|"$/g, '');
                break;
        }

        return `
            <div class="record-item">
                <div class="col-name">${record.name}</div>
                <div class="col-ttl">${formatTTL(record.TTL)}</div>
                <div class="col-type">${typeStr}</div>
                <div class="col-data">${dataStr}</div>
            </div>
        `;
    }).join('');

    return header + records;
};


form.addEventListener('submit', async (event) => {
    event.preventDefault();

    const domain = domainInput.value.trim();
    // 将输入的类型转换为大写，以提高匹配成功率
    const type = typeInput.value.trim().toUpperCase();

    if (!domain) {
        resultsDisplay.className = 'error';
        resultsDisplay.innerHTML = '<p class="status-message error">错误：请输入有效的域名。</p>';
        return;
    }

    // 重置并显示加载状态
    resultsDisplay.className = '';
    resultsDisplay.innerHTML = '<p class="placeholder">查询中，请稍候...</p>';
    setLoadingState(true);


    const dohQueryUrl = `/dns-query?name=${encodeURIComponent(domain)}&type=${type}&ct=application/dns-json`;

    try {
        const response = await fetch(dohQueryUrl, {
            method: 'GET',
            headers: { 'Accept': 'application/dns-json' }
        });

        if (!response.ok) {
            // 尝试读取错误响应体
            const errorText = await response.text();
            let errorMessage = `网络请求失败: ${response.status} ${response.statusText}.`;
            if (errorText) {
                errorMessage += `\n服务器响应: ${errorText}`;
            }
            throw new Error(errorMessage);
        }
        
        const data = await response.json();
        const formattedHtml = formatDnsResponse(data);
        resultsDisplay.innerHTML = formattedHtml;

    } catch (error) {
        console.error('查询出错:', error);
        resultsDisplay.className = 'error';
        // 使用 <pre> 标签来保留错误信息中的换行符
        resultsDisplay.innerHTML = `<p class="status-message error">查询出错:<br><pre>${error.message}</pre></p>`;
    } finally {
        setLoadingState(false);
    }
});
