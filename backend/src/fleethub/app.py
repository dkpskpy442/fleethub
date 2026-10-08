from __future__ import annotations

from fastapi import Depends, FastAPI, Request
from fastapi.responses import JSONResponse

from .api.context import require_session
from .api.routers import catalog, fleet, rollouts, system
from .domain.errors import DomainError


def create_app() -> FastAPI:
    app = FastAPI(title="FleetHub", version="0.1.0", docs_url="/api/docs", openapi_url="/api/openapi.json")

    @app.exception_handler(DomainError)
    async def domain_error(_: Request, exc: DomainError) -> JSONResponse:
        return JSONResponse(status_code=exc.status,
                            content={"error": {"code": exc.code, "message": exc.message, "details": exc.details}})

    app.include_router(system.public, prefix="/api")
    for r in (system.router, catalog.router, fleet.router, rollouts.router):
        app.include_router(r, prefix="/api", dependencies=[Depends(require_session)])
    return app


app = create_app()
