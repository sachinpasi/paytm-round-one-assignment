CREATE TABLE shows (
    id             text PRIMARY KEY,
    name           text   NOT NULL,
    price_paise    bigint NOT NULL CHECK (price_paise >= 0),
    total_seats    int    NOT NULL CHECK (total_seats > 0),
    per_user_limit int    NOT NULL DEFAULT 4 CHECK (per_user_limit > 0),
    created_at     timestamptz NOT NULL DEFAULT now()
);

-- one row per seat, so booking can lock seats individually
CREATE TABLE seats (
    show_id        text NOT NULL REFERENCES shows (id),
    seat_id        text NOT NULL,
    status         text NOT NULL DEFAULT 'available'
                   CHECK (status IN ('available', 'held', 'confirmed')),
    reservation_id text,
    PRIMARY KEY (show_id, seat_id),
    -- owned exactly when not available
    CHECK ((status = 'available') = (reservation_id IS NULL))
);
