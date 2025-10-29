import os, json, gzip
import pandas as pd
from sqlalchemy import create_engine, text
from dotenv import load_dotenv
from datetime import datetime
from pathlib import Path

# ---- Config ----
load_dotenv()
DB_DSN = os.getenv("DATABASE_URL")
PREDICTION_TABLE = "prediction"

# Write output under assets/backend with a proper filename
OUT_GZ = Path("assets/backend/predictions.json.gz")

# Ensure parent exists and OUT_GZ is not a directory
OUT_GZ.parent.mkdir(parents=True, exist_ok=True)
if OUT_GZ.exists() and OUT_GZ.is_dir():
    raise IsADirectoryError(f"OUT_GZ points to a directory: {OUT_GZ}")

engine = create_engine(DB_DSN, pool_pre_ping=True, future=True)

# --- Pull h3 + probability exactly as stored (no GROUP BY, no averaging) ---
sql_preds = text(f"""
    SELECT
        h3::text            AS h3,
        probability::float  AS probability
    FROM {PREDICTION_TABLE}
    WHERE probability IS NOT NULL
""")

with engine.begin() as conn:
    df = pd.read_sql(sql_preds, conn)

if df.empty:
    raise SystemExit("No rows returned. Check table/columns/SQL.")

# Basic cleanup (no parent_h3; no averaging)
df = df.dropna(subset=["h3", "probability"]).copy()
df["probability"] = df["probability"].clip(lower=0.0, upper=1.0)

# Build records [[h3, probability], ...]
records = list(map(list, zip(
    df["h3"].astype(str).tolist(),
    df["probability"].astype(float).tolist()
)))

# --- Get latest weather_datetime (scalar) ---
sql_latest_weather = text("""
    SELECT retrieved_at_utc
    FROM weather_live
    ORDER BY retrieved_at_utc DESC
    LIMIT 1
""")

with engine.begin() as conn:
    val = conn.execute(sql_latest_weather).scalar_one_or_none()

if val is None:
    weather_text = None
elif isinstance(val, datetime):
    weather_text = val.isoformat()
else:
    weather_text = str(val)

# --- Payload + write gzipped JSON ---
payload = {
    "data": records,                   # [[h3, probability], ...] as-is
    "meta": {"weather_datetime": weather_text}
}

# NOTE: Path -> str for gzip on some Python versions
with gzip.open(str(OUT_GZ), "wb") as f:
    f.write(json.dumps(payload, separators=(",", ":")).encode("utf-8"))

print(f"Wrote {OUT_GZ}  rows={len(records)}  meta.weather_datetime={weather_text}")
