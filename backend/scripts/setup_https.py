from __future__ import annotations

import ipaddress
import socket
from datetime import datetime, timedelta, timezone
from pathlib import Path

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID

BASE_DIR = Path(__file__).resolve().parents[1]
CERT_DIR = BASE_DIR / "certs"
KEY_PATH = CERT_DIR / "backend-key.pem"
CERT_PATH = CERT_DIR / "backend.pem"


def get_lan_ips() -> list[str]:
    host_ips = {"127.0.0.1", "localhost"}
    try:
        hostname = socket.gethostname()
        for info in socket.getaddrinfo(hostname, None, family=socket.AF_INET):
            host_ips.add(info[4][0])
    except OSError:
        pass
    return sorted(host_ips)


def build_certificate() -> None:
    CERT_DIR.mkdir(parents=True, exist_ok=True)
    private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    subject = issuer = x509.Name(
        [
            x509.NameAttribute(NameOID.COUNTRY_NAME, "JP"),
            x509.NameAttribute(NameOID.ORGANIZATION_NAME, "VisionLink"),
            x509.NameAttribute(NameOID.COMMON_NAME, "VisionLink Backend Dev"),
        ]
    )

    san_entries: list[x509.GeneralName] = []
    for value in get_lan_ips():
        try:
            san_entries.append(x509.IPAddress(ipaddress.ip_address(value)))
        except ValueError:
            san_entries.append(x509.DNSName(value))

    certificate = (
        x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(issuer)
        .public_key(private_key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(datetime.now(timezone.utc) - timedelta(minutes=5))
        .not_valid_after(datetime.now(timezone.utc) + timedelta(days=365))
        .add_extension(x509.SubjectAlternativeName(san_entries), critical=False)
        .add_extension(x509.BasicConstraints(ca=True, path_length=None), critical=True)
        .sign(private_key, hashes.SHA256())
    )

    KEY_PATH.write_bytes(
        private_key.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.TraditionalOpenSSL,
            encryption_algorithm=serialization.NoEncryption(),
        )
    )
    CERT_PATH.write_bytes(certificate.public_bytes(serialization.Encoding.PEM))
    print(f"Generated backend HTTPS certificate: {CERT_PATH}")


if __name__ == "__main__":
    build_certificate()

