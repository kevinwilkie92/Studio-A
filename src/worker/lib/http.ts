import { HTTPException } from 'hono/http-exception'

type ErrorStatus = 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500

/** Client-facing error with a stable shape: `{ error: { message, code } }`. */
export function fail(status: ErrorStatus, message: string, code?: string): never {
  throw new HTTPException(status, {
    res: Response.json({ error: { message, code: code ?? null } }, { status }),
  })
}

// These are function declarations rather than arrow consts on purpose:
// TypeScript only narrows control flow past a never-returning call when the
// callee is a function declaration or an explicitly typed const.
export function badRequest(message: string, code?: string): never {
  return fail(400, message, code)
}

export function unauthorized(message = 'Please sign in.'): never {
  return fail(401, message, 'unauthenticated')
}

export function forbidden(message = 'You do not have access to that.'): never {
  return fail(403, message, 'forbidden')
}

export function notFound(message = 'Not found.'): never {
  return fail(404, message, 'not_found')
}

export function conflict(message: string, code?: string): never {
  return fail(409, message, code)
}
