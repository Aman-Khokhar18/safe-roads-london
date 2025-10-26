import os, json, gzip
import pandas as pd
import numpy as np
from sqlalchemy import create_engine, text
from dotenv import load_dotenv
from datetime import datetime

# ---- Config ----
load_dotenv()
DB_DSN = os.getenv("DATABASE_URL")

prediction_table = "prediction"

# De-dupe IN SQL:
# - probability = AVG(probability) per h3
# - parent_h3   = most frequent parent_h3 per h3 (ties broken lexicographically)
pred_query = f"""
WITH base AS (
  SELECT
    h3::text        AS h3,
    parent_h3::text AS parent_h3,
    probability::float AS probability
  FROM {prediction_table}
),
avg_prob AS (
  SELECT h3, AVG(probability) AS probability
  FROM base
  GROUP BY h3
),
parent_mode AS (
  SELECT h3, parent_h3
  FROM (
    SELECT
      h3,
      parent_h3,
      ROW_NUMBER() OVER (
        PARTITION BY h3
        ORDER BY COUNT(*) DESC, parent_h3
      ) AS rn
    FROM base
    GROUP BY h3, parent_h3
  ) t
  WHERE rn = 1
)
SELECT a.h3, m.parent_h3, a.probability
FROM avg_prob a
JOIN parent_mode m USING (h3)
"""

OUT_GZ = "h3_payload.json.gz"

# Outlier handling
OUTLIER_LOW  = 0.05
OUTLIER_HIGH = 0.95

engine = create_engine(DB_DSN, pool_pre_ping=True, future=True)

# --- Pull prediction rows (already de-duped by SQL) ---
with engine.begin() as conn:
    df = pd.read_sql(text(pred_query), conn)

if df.empty:
    raise SystemExit("No rows returned. Check table/columns/SQL.")

# Clean obvious nulls (shouldn't happen after SQL, but safe)
df = df.dropna(subset=["h3", "parent_h3", "probability"]).copy()

# --- Replace outliers with parent_h3 mean ---
mask_outlier = (df["probability"] < OUTLIER_LOW) | (df["probability"] > OUTLIER_HIGH)

# Mean per parent (from the de-duplicated set)
parent_mean = df.groupby("parent_h3")["probability"].mean()

# Global fallback (in case a parent has no mean)
global_mean = float(df["probability"].mean())

# Map parent mean to outliers
if mask_outlier.any():
    repl_vals = df.loc[mask_outlier, "parent_h3"].map(parent_mean).fillna(global_mean)
    df.loc[mask_outlier, "probability"] = repl_vals.values

# Clamp to [0,1] just to be safe
df["probability"] = df["probability"].clip(lower=0.0, upper=1.0)

# --- Build records list AFTER normalisation ---
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

print(
    f"Wrote {OUT_GZ}  rows={len(records)}  "
    f"meta.weather_datetime={weather_text}  "
    f"outliers_replaced={int(mask_outlier.sum())}"
)
