-- Starter data. Safe to re-run: every insert is OR IGNORE / upsert.
-- Edit the services and hours to match the salon, then:
--   npm run db:seed:local   (or db:seed for production)

INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES
  ('salon_name',            'Studio A',                          unixepoch()),
  ('timezone',              'America/New_York',                  unixepoch()),
  ('currency',              'usd',                               unixepoch()),
  ('slot_interval_min',     '15',                                unixepoch()),
  ('buffer_min',            '0',                                 unixepoch()),
  ('booking_lead_hours',    '2',                                 unixepoch()),
  ('booking_horizon_days',  '60',                                unixepoch()),
  ('cancel_window_hours',   '24',                                unixepoch()),
  ('reminder_offsets_hours','24,2',                              unixepoch()),
  ('reminder_quiet_start',  '21',                                unixepoch()),
  ('reminder_quiet_end',    '9',                                 unixepoch()),
  ('booking_confirmation_sms', '1',                              unixepoch()),
  ('sms_footer',            'Reply STOP to opt out.',            unixepoch()),
  ('address',               '',                                  unixepoch()),
  ('phone',                 '',                                  unixepoch());

INSERT OR IGNORE INTO services
  (id, name, description, category, duration_min, price_cents, deposit_cents, active, sort_order, created_at, updated_at)
VALUES
  ('svc_womens_cut',  'Women''s Cut & Style', 'Consultation, shampoo, cut and blow-dry finish.', 'Cuts',   60,  6500,    0, 1, 10, unixepoch(), unixepoch()),
  ('svc_mens_cut',    'Men''s Cut',           'Clipper or scissor cut with hot-towel neck finish.', 'Cuts', 30,  3500,    0, 1, 20, unixepoch(), unixepoch()),
  ('svc_kids_cut',    'Kids'' Cut (12 & under)', 'Quick, patient cut for younger clients.',      'Cuts',   30,  2500,    0, 1, 30, unixepoch(), unixepoch()),
  ('svc_blowout',     'Blowout',              'Shampoo and smooth blow-dry style.',              'Styling', 45, 4500,    0, 1, 40, unixepoch(), unixepoch()),
  ('svc_updo',        'Special Occasion Updo','Formal styling for weddings and events.',         'Styling', 75, 9500, 2500, 1, 50, unixepoch(), unixepoch()),
  ('svc_root_touch',  'Root Touch-Up',        'Single-process color on regrowth only.',          'Color',   90,  9000, 2500, 1, 60, unixepoch(), unixepoch()),
  ('svc_allover',     'All-Over Color',       'Single-process color, roots through ends.',       'Color',  120, 12000, 2500, 1, 70, unixepoch(), unixepoch()),
  ('svc_partial_foil','Partial Highlight',    'Foils through the crown and face-frame.',         'Color',  150, 16000, 5000, 1, 80, unixepoch(), unixepoch()),
  ('svc_full_foil',   'Full Highlight',       'Full head of foils with toner and style.',        'Color',  210, 22500, 5000, 1, 90, unixepoch(), unixepoch()),
  ('svc_balayage',    'Balayage',             'Hand-painted lightening with gloss and style.',   'Color',  240, 27500, 7500, 1, 100, unixepoch(), unixepoch()),
  ('svc_gloss',       'Gloss / Toner',        'Refreshes tone and shine between color services.','Color',   45,  5500,    0, 1, 110, unixepoch(), unixepoch()),
  ('svc_deep_cond',   'Deep Conditioning',    'Add-on bond and moisture treatment.',             'Treatments', 20, 3000, 0, 1, 120, unixepoch(), unixepoch()),
  ('svc_keratin',     'Keratin Smoothing',    'Frizz-reducing smoothing treatment.',             'Treatments', 180, 25000, 7500, 1, 130, unixepoch(), unixepoch());

INSERT OR IGNORE INTO staff (id, user_id, display_name, title, bio, active, sort_order)
VALUES ('stf_main', NULL, 'Any available stylist', 'Studio A', '', 1, 0);

-- Tue-Sat, 9:00-18:00 (Sat until 16:00). weekday 0 = Sunday.
INSERT OR IGNORE INTO staff_hours (id, staff_id, weekday, start_min, end_min) VALUES
  ('sh_main_2', 'stf_main', 2, 540, 1080),
  ('sh_main_3', 'stf_main', 3, 540, 1080),
  ('sh_main_4', 'stf_main', 4, 540, 1080),
  ('sh_main_5', 'stf_main', 5, 540, 1080),
  ('sh_main_6', 'stf_main', 6, 540,  960);
