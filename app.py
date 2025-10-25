import os, json, gzip
import pandas as pd
from sqlalchemy import create_engine, text
from dotenv import load_dotenv

# ---- Config ----
load_dotenv()
DB_DSN      = os.getenv("DATABASE_URL")
TABLE_NAME  = "prediction"
SQL_QUERY   = f"SELECT h3::text AS h3, probability::float AS probability FROM {TABLE_NAME}"

OUT_GZ      = "h3_payload.json.gz"                 

if not DB_DSN:
    raise SystemExit("Set DATABASE_URL env var, e.g. postgresql+psycopg2://user:pass@host:5432/dbname")

engine = create_engine(DB_DSN, pool_pre_ping=True, future=True)
with engine.begin() as conn:
    df = pd.read_sql(text(SQL_QUERY), conn)

if df.empty:
    raise SystemExit("No rows returned. Check table/columns/SQL.")

records = list(map(list, zip(df["h3"].astype(str).tolist(),
                             df["probability"].astype(float).tolist())))

payload = {"data": records}

with gzip.open(OUT_GZ, "wb") as f:
    f.write(json.dumps(payload, separators=(",", ":")).encode("utf-8"))

print(f"Wrote {OUT_GZ}  rows={len(records)}")
