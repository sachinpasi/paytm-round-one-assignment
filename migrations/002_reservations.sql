CREATE TABLE reservations (
    id           text PRIMARY KEY,
    show_id      text   NOT NULL REFERENCES shows (id),
    user_id      text   NOT NULL,
    seats        text[] NOT NULL,
    amount_paise bigint NOT NULL,
    status       text   NOT NULL CHECK (status IN ('confirmed', 'cancelled')),
    created_at   timestamptz NOT NULL DEFAULT now(),
    cancelled_at timestamptz
);

-- a seat's owner has to be a real reservation
ALTER TABLE seats ADD FOREIGN KEY (reservation_id) REFERENCES reservations (id);
