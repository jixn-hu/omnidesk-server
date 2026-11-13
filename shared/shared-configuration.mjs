export function sharedConfiguration(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input))
        throw new Error('共享连接配置格式不正确');
    const value = input;
    const text = (name, maximum, required = false) => {
        const entry = value[name];
        if (entry === undefined && !required)
            return undefined;
        if (typeof entry !== 'string' || entry.length > maximum || entry.includes('\0') || (name !== 'note' && /[\r\n]/.test(entry)) || (required && !entry.trim()))
            throw new Error('共享连接字段格式不正确：' + name);
        return entry;
    };
    if (!['ssh', 'rdp'].includes(value.kind) || !Number.isInteger(value.port) || Number(value.port) < 1 || Number(value.port) > 65535)
        throw new Error('共享协议或端口格式不正确');
    const authMethod = value.kind === 'rdp' ? 'password' : value.authMethod;
    if (!['password', 'privateKey'].includes(authMethod))
        throw new Error('配置共享需要已保存的密码或私钥，不支持 SSH Agent');
    const result = { kind: value.kind, name: text('name', 256, true), host: text('host', 1024, true), port: Number(value.port), username: text('username', 256, true), authMethod: authMethod, domain: text('domain', 256), note: text('note', 16384), group: text('group', 256), color: text('color', 128) };
    if (value.tags !== undefined) {
        if (!Array.isArray(value.tags) || value.tags.length > 100 || value.tags.some(tag => typeof tag !== 'string' || tag.length > 128 || /[\0\r\n]/.test(tag)))
            throw new Error('共享标签格式不正确');
        result.tags = [...value.tags];
    }
    if (result.kind === 'rdp') {
        const options = value.options ?? { ignoreCertificate: value.ignoreCertificate !== false };
        if (!options || typeof options !== 'object' || Array.isArray(options))
            throw new Error('共享 RDP 选项格式不正确');
        const raw = options;
        result.options = { ignoreCertificate: true };
        if (raw.engine !== undefined) {
            if (!['ironrdp', 'freerdp'].includes(raw.engine))
                throw new Error('共享 RDP 引擎不正确');
            result.options.engine = raw.engine;
        }
        if (raw.securityMode !== undefined) {
            if (!['auto', 'legacy'].includes(raw.securityMode))
                throw new Error('共享 RDP 安全模式不正确');
            result.options.securityMode = raw.securityMode;
        }
        if (raw.performanceMode !== undefined) {
            if (!['smooth', 'balanced', 'clear'].includes(raw.performanceMode))
                throw new Error('共享 RDP 画质模式不正确');
            result.options.performanceMode = raw.performanceMode;
        }
        for (const name of ['dynamicResolution', 'fullscreen', 'systemSmartSizing', 'enableClipboard', 'showWallpaper', 'fontSmoothing', 'desktopComposition', 'showDraggedWindow', 'showMenuAnimations', 'showThemes', 'showBlinkingCursor', 'ignoreCertificate']) {
            if (raw[name] !== undefined) {
                if (typeof raw[name] !== 'boolean')
                    throw new Error('共享 RDP 开关格式不正确');
                result.options[name] = raw[name];
            }
        }
        if (raw.audioCaptureMode !== undefined) {
            if (!['none', 'local', 'remote'].includes(raw.audioCaptureMode))
                throw new Error('共享音频选项格式不正确');
            result.options.audioCaptureMode = raw.audioCaptureMode;
        }
        if (raw.colorDepth !== undefined) {
            if (![16, 24, 32].includes(raw.colorDepth))
                throw new Error('共享色深选项格式不正确');
            result.options.colorDepth = raw.colorDepth;
        }
    }
    return result;
}
