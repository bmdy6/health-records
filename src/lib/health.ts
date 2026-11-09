import { createDavClient, getConfig, getConfigRevision } from './webdav';
import type { BodyProfileAccess } from './body';
import { createHealthStore } from './health-store';
function assertAccess(access: BodyProfileAccess) {
    if (!access.isCurrent())
        throw new Error('健康操作已取消');
}
function captureAccess(access?: BodyProfileAccess): BodyProfileAccess {
    if (access) {
        assertAccess(access);
        if (!access.config?.url || !access.config.username || !access.config.password)
            throw new Error('请先绑定个人工作台');
        return access;
    }
    const cfg = getConfig();
    if (!cfg)
        throw new Error('请先绑定个人工作台');
    const config = { ...cfg };
    const revision = getConfigRevision();
    return { config, revision, isCurrent: () => { const current = getConfig(); return getConfigRevision() === revision && current?.url === config.url && current.username === config.username && current.password === config.password; } };
}
// Adapt existing WebDAV transport (including local proxy) to the shared service.
function browserStore(access: BodyProfileAccess) {
    const cfg = { ...access.config };
    const client = createDavClient(cfg);
    const base = new URL(cfg.url.endsWith('/') ? cfg.url : `${cfg.url}/`);
    const fetcher: typeof fetch = async (input, init) => {
        assertAccess(access);
        const url = new URL(String(input));
        const path = decodeURIComponent(url.pathname.slice(base.pathname.length));
        if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname))
            throw new Error('健康请求位置无效');
        try {
            if (init?.method === 'PUT') {
                const result = await client.putFileContents(path, String(init.body), { overwrite: true, headers: Object.fromEntries(new Headers(init.headers)), signal: init.signal ?? undefined });
                assertAccess(access);
                if (result === false)
                    throw new Error('服务端未确认保存健康记录');
                return new Response(null, { status: 204 });
            }
            const result = await client.getFileContents(path, { format: 'text', details: true, signal: init?.signal ?? undefined }) as unknown as {
                data: string;
                headers: Headers | Record<string, string>;
            };
            assertAccess(access);
            return new Response(result.data, { headers: result.headers });
        }
        catch (error) {
            assertAccess(access);
            const status = (error as {
                status?: number;
                response?: {
                    status?: number;
                };
            })?.status ??
                (error as {
                    response?: {
                        status?: number;
                    };
                })?.response?.status;
            if (status && status >= 400 && status <= 599)
                return new Response(null, { status });
            throw error;
        }
    };
    return createHealthStore(cfg, fetcher);
}
export function createBrowserHealthStore(access?: BodyProfileAccess) { return browserStore(captureAccess(access)); }
