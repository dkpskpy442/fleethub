"""Cloudflare Workers entrypoint: FastAPI served via the Workers ASGI adapter.
Static assets (the React build) are served by the Workers assets binding for non-/api paths."""
from workers import asgi

from fleethub.app import app

Default = asgi.entrypoint(app)
