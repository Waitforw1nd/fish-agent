import { Hono } from 'hono'
import { authMiddleware } from '@/webui/BE/auth'

/**
 * 包装子路由为可测试的 Hono app（无鉴权）
 */
export function createTestApp(subrouter: Hono, prefix = '/') {
  const app = new Hono()
  app.route(prefix, subrouter)
  return app
}

/**
 * 创建带鉴权中间件的测试 app
 * 注入 mock env 以避免 c.env.incoming.socket.remoteAddress 报错
 */
export function createAuthTestApp() {
  const app = new Hono()
  app.use('*', async (c, next) => {
    c.env = { incoming: { socket: { remoteAddress: '127.0.0.1' } } } as any
    return await next()
  })
  app.use('*', authMiddleware)
  // 添加一个简单的测试路由
  app.get('/test', (c) => c.json({ success: true, message: 'authenticated' }))
  app.post('/set-token', (c) => c.json({ success: true, message: 'token set' }))
  return app
}
