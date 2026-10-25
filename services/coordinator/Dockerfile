# Build from repository root; pin the resolved digest in the deployment release record.
FROM python:3.12-slim
WORKDIR /app
RUN useradd --uid 10001 --create-home heyuna
COPY pyproject.toml uv.lock ./
COPY backend ./backend
RUN pip install --no-cache-dir uv==0.9.5 && uv sync --frozen --no-dev
ENV PATH="/app/.venv/bin:$PATH"
USER heyuna
EXPOSE 8080
CMD ["uvicorn", "heyuna.coordinator:create_coordinator_app", "--factory", "--host", "0.0.0.0", "--port", "8080", "--workers", "1", "--no-server-header", "--limit-concurrency", "32"]
