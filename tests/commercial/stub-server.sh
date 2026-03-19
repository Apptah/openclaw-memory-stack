#!/usr/bin/env bash
# Stub license server for commercial tests
# Usage: stub-server.sh [port]
# Runs a simple Python HTTP server that simulates CF Worker endpoints

PORT="${1:-9199}"

python3 -u << 'PYEOF' "$PORT" &
import http.server
import json
import sys

PORT = int(sys.argv[1])

# In-memory state
licenses = {
    "oc-starter-test123": {
        "tier": "starter",
        "email": "test@example.com",
        "active": True,
        "devices": [
            {"id": "testdevice1234", "name": "Test Machine", "added_at": "2026-01-01T00:00:00Z"}
        ],
        "max_devices": 3
    },
    "oc-starter-revoked": {
        "tier": "starter",
        "email": "test@example.com",
        "active": False,
        "devices": [],
        "max_devices": 3
    },
    "oc-starter-full3": {
        "tier": "starter",
        "email": "test@example.com",
        "active": True,
        "devices": [
            {"id": "dev1", "name": "D1", "added_at": "2026-01-01T00:00:00Z"},
            {"id": "dev2", "name": "D2", "added_at": "2026-01-01T00:00:00Z"},
            {"id": "dev3", "name": "D3", "added_at": "2026-01-01T00:00:00Z"}
        ],
        "max_devices": 3
    }
}
processed_webhooks = set()
reset_counts = {}

class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, format, *args): pass  # suppress logs

    def send_json(self, data, status=200):
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(data).encode())

    def do_GET(self):
        if self.path.startswith("/api/verify"):
            from urllib.parse import urlparse, parse_qs
            qs = parse_qs(urlparse(self.path).query)
            key = qs.get("key", [""])[0]
            device_id = qs.get("device_id", [""])[0]

            lic = licenses.get(key)
            if not lic:
                return self.send_json({"valid": False, "reason": "invalid_key"}, 403)
            if not lic["active"]:
                return self.send_json({"valid": False, "reason": "revoked"}, 403)
            if not any(d["id"] == device_id for d in lic["devices"]):
                return self.send_json({"valid": False, "reason": "device_not_activated"}, 403)
            return self.send_json({"valid": True, "tier": lic["tier"]})

        self.send_json({"error": "not found"}, 404)

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(length)) if length > 0 else {}

        if self.path == "/api/activate":
            key = body.get("key", "")
            device_id = body.get("device_id", "")
            device_name = body.get("device_name", "Unknown")

            lic = licenses.get(key)
            if not lic:
                return self.send_json({"valid": False, "reason": "invalid_key"}, 403)
            if not lic["active"]:
                return self.send_json({"valid": False, "reason": "revoked"}, 403)

            # Already activated
            if any(d["id"] == device_id for d in lic["devices"]):
                return self.send_json({"valid": True, "tier": lic["tier"]})

            if len(lic["devices"]) >= lic["max_devices"]:
                return self.send_json({"valid": False, "reason": "activation_limit_reached", "max": lic["max_devices"]}, 403)

            lic["devices"].append({"id": device_id, "name": device_name, "added_at": "now"})
            return self.send_json({"valid": True, "tier": lic["tier"]})

        if self.path == "/api/reset-device":
            key = body.get("key", "")
            email = body.get("email", "")
            device_id = body.get("device_id", "")

            lic = licenses.get(key)
            if not lic:
                return self.send_json({"valid": False, "reason": "invalid_key"}, 403)
            if lic.get("email") != email:
                return self.send_json({"valid": False, "reason": "email_mismatch"}, 403)

            lic["devices"] = [d for d in lic["devices"] if d["id"] != device_id]
            return self.send_json({"valid": True, "devices_remaining": len(lic["devices"])})

        if self.path == "/api/webhook":
            event_id = body.get("id", "")
            if event_id in processed_webhooks:
                return self.send_json({"received": True, "duplicate": True})
            processed_webhooks.add(event_id)
            return self.send_json({"received": True})

        self.send_json({"error": "not found"}, 404)

server = http.server.HTTPServer(("127.0.0.1", PORT), Handler)
print(f"Stub server running on port {PORT}", flush=True)
server.serve_forever()
PYEOF

STUB_PID=$!
echo "$STUB_PID"

# Wait for server to be ready
for i in $(seq 1 20); do
  if curl -sf "http://localhost:$PORT/api/verify?key=test&device_id=test" &>/dev/null; then
    break
  fi
  sleep 0.1
done
