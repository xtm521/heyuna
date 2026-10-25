FROM python:3.12-slim-bookworm@sha256:6a0e06f5ba0b373d051aabd3fffb9b873f27f9a2a3a14bcbe37dee6f0e3bbc70
RUN apt-get update && apt-get install -y --no-install-recommends nodejs npm && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir pytest==8.4.2 && npm install -g typescript@5.9.3
LABEL org.heyuna.sandbox.policy="pid1-watchdog-v1"
# Isolated PID 1 owns the deadline. PR_SET_DUMPABLE prevents a same-UID child
# from changing its memory through ptrace/process_vm_writev or /proc/1/mem.
# Namespace init also rejects unhandled signals from ordinary child processes.
COPY watchdog.py /usr/local/lib/heyuna-watchdog.py
RUN chmod 0444 /usr/local/lib/heyuna-watchdog.py
WORKDIR /workspace
USER 65532:65532
ENTRYPOINT ["/usr/local/bin/python", "-I", "/usr/local/lib/heyuna-watchdog.py", "120"]
CMD ["python", "-m", "unittest", "discover"]
