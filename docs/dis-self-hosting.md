# Innovatrics DIS 1.59.1 – Self-Hosting Guide

This document captures the full process for running Innovatrics Digital Identity Service (DIS) version 1.59.1 on your own infrastructure. It covers two supported paths:

1. **Native Docker host** – any workstation or server where Docker runs natively.
2. **macOS + Ubuntu VM** – for Macs that cannot run Docker Desktop (e.g., Monterey + Intel), we run DIS inside an Ubuntu guest with Docker.

Use whichever path matches your hardware.

---

## 1. Prerequisites

| Requirement     | Native Docker Host                                                                 | macOS + Ubuntu VM                                                                   |
| --------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Free disk space | ≥ 40 GB                                                                            | ≥ 40 GB on macOS host **plus** ≥ 50 GB allocated to the VM disk                     |
| OS / Engine     | Linux / macOS / Windows with Docker Engine + compose plugin                        | VirtualBox (or UTM/VMware) running Ubuntu 22.04 with Docker Engine + compose plugin |
| Files           | `dot-digital-identity-service-1.59.1-amd64.zip` (≈ 6 GB) and `iengine.lic` license | Same files                                                                          |
| Network         | Ability to expose port 8080 (or chosen HTTP port)                                  | VirtualBox NAT rule forwarding host port 8080 → guest 8080                          |
| Credentials     | Innovatrics API Key & Secret (from the customer portal)                            | Same                                                                                |

> **License**: Request the DOT Server license via Innovatrics portal. Download the file and keep it named `iengine.lic`.
>
> **API credentials**: In the portal, open the “API Key & Secret” popup. The bearer token is `Base64(apiKey:apiSecret)`.

---

## 2. Prepare the DIS bundle (common steps)

```bash
unzip dot-digital-identity-service-1.60.1-amd64.zip
cd dot-digital-identity-service-1.60.1-amd64

mkdir -p license logs
cp /path/to/iengine.lic license/iengine.lic
```

The directory should now look like:

```
dot-digital-identity-service-1.60.1-amd64/
├─ config/
├─ doc/
├─ docker-compose.yml
├─ linux/amd64/ (contains dot-digital-identity-service.jar + libs)
├─ license/iengine.lic
└─ logs/
```

`config/` is bind-mounted into the container, so any edits you make there (Redis host, logging, security overrides) take effect on restart.

---

## 3. Native Docker workflow

1. **Install Docker Engine + compose plugin** (see docs.docker.com for your OS).
2. _(Optional)_ `docker login registry.dot.innovatrics.com` if Innovatrics shares their private registry. Otherwise Compose builds the image locally.
3. **Start DIS**
   ```bash
   cd /path/to/dot-digital-identity-service-1.60.1-amd64
   docker compose up -d
   ```
4. **Follow logs**
   ```bash
   docker compose logs -f
   ```
5. **Verify**
   ```bash
   curl -v http://localhost:8080/actuator/health \
        -H "Authorization: Bearer <Base64(apiKey:apiSecret)>"
   ```
   Health endpoints may be open by default (200) or require auth (401) depending on security config. Use `/api/v1/info` to confirm DIS itself is reachable after port forwarding: `curl http://localhost:8080/api/v1/info`.

---

## 4. macOS + Ubuntu VM workflow (Docker inside VM)

1. **Create the VM**
   - VirtualBox → New VM → Ubuntu 22.04 (64-bit)
   - Allocate ≥ 4 GB RAM, ≥ 4 vCPUs, ≥ 50 GB disk (dynamic is OK).

2. **Install Ubuntu** inside the VM.

3. **Install Docker inside Ubuntu**

   ```bash
   sudo apt update
   sudo apt install -y docker.io docker-compose-plugin cloud-guest-utils lvm2
   sudo usermod -aG docker $USER
   newgrp docker
   docker --version
   docker compose version
   ```

4. **(Optional) Expand the VM disk** if you run out of space later:

   ```bash
   VBoxManage modifymedium disk ~/VirtualBox\ VMs/ubuntu-dis/ubuntu-dis.vdi --resize 50000
   sudo growpart /dev/sda 3
   sudo pvresize /dev/sda3
   sudo lvextend -l +100%FREE /dev/mapper/ubuntu--vg-ubuntu--lv
   sudo resize2fs /dev/mapper/ubuntu--vg-ubuntu--lv
   ```

5. **Enable SSH + port forwarding**

   ```bash
   sudo apt install -y openssh-server
   ```

   VirtualBox → Settings → Network → Adapter 1 (NAT) → Advanced → Port Forwarding:
   - Host `127.0.0.1:2222` → Guest `22` (SSH)
   - Host `127.0.0.1:8080` → Guest `8080` (HTTP)

6. **Copy the bundle + license into the VM**

   ```bash
   tar czf dis-bundle.tar.gz dot-digital-identity-service-1.60.1-amd64
   scp -P 2222 dis-bundle.tar.gz kolade@127.0.0.1:~
   scp -P 2222 dot-digital-identity-service-1.60.1-amd64/license/iengine.lic \
       kolade@127.0.0.1:~
   ```

   Inside the VM:

   ```bash
   cd ~
   tar xzf dis-bundle.tar.gz
   mv ~/iengine.lic ~/dot-digital-identity-service-1.60.1-amd64/license/
   ```

7. **Run DIS inside the VM**

   ```bash
   cd ~/dot-digital-identity-service-1.60.1-amd64
   docker compose up -d
   docker ps
   ```

8. **Test from macOS**
   ```bash
   curl -v http://localhost:8080/actuator/health \
        -H "Authorization: Bearer <Base64(apiKey:apiSecret)>"
   curl -v http://localhost:8080/api/v1/info
   ```
   (If you get HTTP 401, your token is missing/invalid. If you get connection errors, double-check VirtualBox port forwarding.)

---

## 5. Authentication & Authorization

- DIS 1.20.0+ only accepts API Key authentication.
- Use the Innovatrics portal to generate the **API Key** and **API Secret** (the “API Key & Secret” popup shows three values—copy the ones for your environment). The bearer token is still `Base64(apiKey:apiSecret)`.
  ```bash
  echo -n 'apiKey:apiSecret' | base64
  ```
- Add this header to every request:
  ```http
  Authorization: Bearer <Base64(apiKey:apiSecret)>
  ```
- Some endpoints (`/metrics`, `/health`, `/info`) are open by default; others require the bearer token.
- **Register API clients in `config/application.yml`.** DIS will reject requests until the API key/secret pair is added to the `security.apiClients` block. Example:
  ```yaml
  security:
    apiClients:
      - clientId: 'INK_xxxxx'
        clientSecret: 'INS_xxxxx'
        roles:
          - CUSTOMER_CREATE
          - CUSTOMER_READ
          - DOCUMENT_CREATE
          - DOCUMENT_VERIFY
          - FACE_DETECTION
          - FACE_COMPARISON
          - PASSIVE_LIVENESS
          - WORKFLOW_CREATE
  ```
  Restart `docker compose` after editing so DIS reloads the credentials.
- If you need to harden or customize auth, continue editing `config/application.yml` (e.g., security roles, redis creds) and restart `docker compose`.

> **Local DIS base URL reminder**: container endpoints live under `/api/v1` (e.g., `http://localhost:8080/api/v1`). The legacy `/identity/api/v1` path only applies to Innovatrics’ hosted service.

---

## 6. Verification checklist

1. `docker compose up -d` starts two containers: `digital-identity-service` and `dis-redis`.
2. `docker compose logs -f` contains `Tomcat started on port 8080` and `Application running inside docker` messages.
3. `curl http://localhost:8080/actuator/health -H 'Authorization: Bearer …'` returns HTTP 200 with JSON status.
4. The provided Postman collection (`doc/postman/*.json`) works when pointed at `http://localhost:8080` and using the same bearer token.
5. Your application (`kyc-verification`) points to the local base URL:
   ```env
   INNOVATRICS_BASE_URL=http://localhost:8080/api/v1
   INNOVATRICS_HOST=localhost:8080
   INNOVATRICS_BEARER_TOKEN=<Base64(apiKey:apiSecret)>
   DIS_SKIP_STORE=true        # optional flag while /customers/{id}/store is unavailable
   ```

---

## 7. Troubleshooting

| Problem                                                            | Fix                                                                                                                                             |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `docker compose` not found                                         | Install the compose plugin (`sudo apt install docker-compose-plugin` on Ubuntu, or ensure Docker Desktop is installed on macOS/Windows).        |
| `no space left on device`                                          | Free host disk space; in a VM, expand the VDI and resize LVM (see step 4).                                                                      |
| HTTP 401 responses                                                 | Double-check bearer token (must be `Base64(apiKey:apiSecret)`), confirm header is present, ensure you restarted after config changes.           |
| HTTP 403 responses on every endpoint                               | Confirm your API key/secret is registered under `security.apiClients` inside the container. Without it DIS accepts the token but blocks access. |
| `/customers/{id}/store` returns 404                                | Some self-hosted bundles do not expose this route. Set `DIS_SKIP_STORE=true` (backend) or guard the call so the rest of the flow can proceed.   |
| `curl localhost:8080` fails on macOS                               | Confirm VirtualBox NAT rule Host 8080 → Guest 8080, ensure container listens on `0.0.0.0:8080`, restart VM if the rule changed.                 |
| Docker build error “dot-digital-identity-service.jar not found”    | Re-extract the bundle and copy `linux/amd64/dot-digital-identity-service.jar` back into the working directory before running Compose.           |
| SSH to VM fails (`kex_exchange_identification` / connection reset) | VM is likely paused due to host disk pressure. Free space, resume (`VBoxManage controlvm "ubuntu-dis" resume`), then reconnect.                 |

---

## 8. Handy commands

```bash
# Start / restart services
cd dot-digital-identity-service-1.60.1-amd64
docker compose up -d

# Rebuild after config changes
docker compose up --build -d

# Stop services
docker compose down

# Tail logs
docker compose logs -f

# Health check with auth
curl -v http://localhost:8080/actuator/health \
     -H "Authorization: Bearer <Base64(apiKey:apiSecret)>"

# Quick sanity endpoint
curl -v http://localhost:8080/api/v1/info
```

Refer to `doc/Innovatrics_DOT_Digital_Identity_Service_Installation.pdf` (or the HTML copy in the repo) for deeper configuration topics such as memcached, Redis clustering, biometric thresholds, and logging. Keep the Postman collection in `doc/postman/` handy for manual API tests.
