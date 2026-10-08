class DomainError(Exception):
    status = 400
    code = "domain_error"

    def __init__(self, message: str, *, code: str | None = None, details: object = None):
        super().__init__(message)
        self.message = message
        if code:
            self.code = code
        self.details = details


class NotFound(DomainError):
    status = 404
    code = "not_found"


class Forbidden(DomainError):
    status = 403
    code = "forbidden"


class Conflict(DomainError):
    status = 409
    code = "conflict"


class GuardrailBlocked(DomainError):
    status = 422
    code = "guardrail_blocked"
