"""CLI entry point; network services fail closed without credentials."""
import argparse
import os
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(prog="heyuna")
    sub = parser.add_subparsers(dest="command", required=True)
    serve = sub.add_parser("serve", help="Start the authenticated local application service")
    serve.add_argument("--port", type=int, default=8765)
    serve.add_argument("--state-dir", default=os.environ.get("HEYUNA_STATE_DIR", ".state"))
    serve.add_argument("--tls-cert", default=os.environ.get("HEYUNA_TLS_CERT"), help="Ephemeral loopback TLS certificate")
    serve.add_argument("--tls-key", default=os.environ.get("HEYUNA_TLS_KEY"), help="Ephemeral loopback TLS private key")
    doctor = sub.add_parser("doctor", help="Report observed runtime capabilities without model download")
    doctor.add_argument("--state-dir", default=".state")
    args = parser.parse_args()
    if args.command == "serve":
        if bool(args.tls_cert) != bool(args.tls_key):
            parser.error("--tls-cert and --tls-key must be provided together")
        import uvicorn

        from .app import create_app
        uvicorn.run(create_app(state_dir=args.state_dir), host="127.0.0.1", port=args.port, access_log=False,
                    ssl_certfile=args.tls_cert, ssl_keyfile=args.tls_key)
    else:
        import json
        import threading

        from .model import ModelRuntime
        from .sandbox import Sandbox
        print(json.dumps({"model": ModelRuntime(Path(args.state_dir), threading.RLock()).snapshot(),
                          "sandbox": Sandbox().status()}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
