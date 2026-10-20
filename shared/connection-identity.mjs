export function parseConnectionAddress(address, fallbackPort) {
    let host = address.trim();
    let port = fallbackPort;
    if (!host)
        throw new Error('请填写主机地址');
    if (/[\s/\\@?#]/.test(host))
        throw new Error('主机地址只需填写 IP 或域名，可附带端口；不要包含协议、路径或账号');
    let explicitPort;
    if (host.startsWith('[')) {
        const match = /^\[([^\]]+)\](?::(.*))?$/.exec(host);
        if (!match || !match[1].includes(':'))
            throw new Error('IPv6 地址格式不正确，带端口时请填写 [地址]:端口');
        host = match[1];
        explicitPort = match[2];
    }
    else if (host.indexOf(':') === host.lastIndexOf(':') && host.includes(':')) {
        const separator = host.indexOf(':');
        explicitPort = host.slice(separator + 1);
        host = host.slice(0, separator);
    }
    if (!host || /[\[\]]/.test(host))
        throw new Error('主机地址格式不正确');
    if (host.includes(':')) {
        const [ip, zone, ...rest] = host.split('%');
        try {
            if (rest.length || (zone !== undefined && !/^[\w.-]+$/.test(zone)))
                throw new Error();
            new URL(`http://[${ip}]/`);
        }
        catch {
            throw new Error('IPv6 地址格式不正确，带端口时请填写 [地址]:端口');
        }
    }
    if (explicitPort !== undefined) {
        if (!/^\d+$/.test(explicitPort))
            throw new Error('地址中的端口必须为 1–65535 之间的整数');
        port = Number(explicitPort);
    }
    if (!Number.isInteger(port) || port < 1 || port > 65535)
        throw new Error('端口必须为 1–65535 之间的整数');
    return { host, port };
}
export function formatConnectionAddress(host, port) {
    try {
        const endpoint = parseConnectionAddress(host, port);
        if (endpoint.host !== host.trim().replace(/^\[([^\]]+)\]$/, '$1') || endpoint.port !== port)
            return host.trim();
    }
    catch { }
    return `${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}:${port}`;
}
export function connectionKey(connection) {
    let endpoint = { host: connection.host, port: connection.port };
    try {
        endpoint = parseConnectionAddress(connection.host, connection.port);
    }
    catch { }
    let host = endpoint.host.trim().toLowerCase().replace(/\.$/, '');
    if (host.startsWith('[') && host.endsWith(']'))
        host = host.slice(1, -1);
    if (host.includes(':')) {
        try {
            host = new URL(`http://[${host}]/`).hostname.replace(/^\[|\]$/g, '');
        }
        catch { }
    }
    return `${connection.kind}|${host}|${endpoint.port}`;
}
export function matchesConnection(connection, query) {
    const haystack = [connection.name, connection.host, connection.port, connection.username, connection.kind,
        formatConnectionAddress(connection.host, connection.port), connection.note, connection.group, ...(connection.tags ?? [])].join(' ').toLowerCase();
    return query.trim().toLowerCase().split(/\s+/).every((word) => haystack.includes(word));
}
