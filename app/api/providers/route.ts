import { ok } from '@/lib/api'
import { getProviderHealth } from '@/lib/providers/health'

export const dynamic = 'force-dynamic'

export async function GET() {
  return ok(await getProviderHealth())
}
