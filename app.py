import os, json, gzip
import pandas as pd
from sqlalchemy import create_engine, text
from dotenv import load_dotenv
from datetime import datetime

# ---- Config ----
load_dotenv()
DB_DSN = os.getenv("DATABASE_URL")

prediction_table = "prediction"
pred_query = f"""
    SELECT h3::text AS h3, probability::float AS probability
    FROM {prediction_table}
"""

OUT_GZ = "h3_payload.json.gz"

engine = create_engine(DB_DSN, pool_pre_ping=True, future=True)

# --- Pull prediction rows ---
with engine.begin() as conn:
    df = pd.read_sql(text(pred_query), conn)

if df.empty:
    raise SystemExit("No rows returned. Check table/columns/SQL.")

records = list(map(list, zip(df["h3"].astype(str).tolist(),
                             df["probability"].astype(float).tolist())))

# --- Get latest weather_datetime (scalar) ---
weather_table = "weather_live"
sql_latest_weather = text(f"""
    SELECT weather_datetime
    FROM {weather_table}
    ORDER BY weather_datetime DESC
    LIMIT 1
""")

with engine.begin() as conn:
    val = conn.execute(sql_latest_weather).scalar_one_or_none()

# Convert to text
if val is None:
    weather_text = None
elif isinstance(val, datetime):
    weather_text = val.isoformat()  # or val.strftime("%Y-%m-%d %H:%M:%S")
else:
    weather_text = str(val)

# --- Build payload with meta + write gzipped JSON ---
payload = {
    "data": records,
    "meta": {
        "weather_datetime": weather_text
    }
}

with gzip.open(OUT_GZ, "wb") as f:
    f.write(json.dumps(payload, separators=(",", ":")).encode("utf-8"))

print(f"Wrote {OUT_GZ}  rows={len(records)}  meta.weather_datetime={weather_text}")
