-- Customers signed in with Google who never added a mobile number, and why.
-- Read-only. Run on the server:
--   sudo bash -c 'set -a; . /etc/gdkites/api.env; set +a; psql "${DATABASE_URL%%\?*}" -P pager=off -x -f /srv/gdkites/api/deploy/no-mobile-report.sql'
-- Codes requested from 18 Nov 2026 on are linked to the account and record why they failed.
-- Older ones aren't linked, so those customers show "no record".
with u as (
  select id, name, email, "createdAt" from "User"
  where role = 'CUSTOMER' and "phoneVerified" is null and (phone is null or phone = '') and email is not null
),
s as (
  select r."userId", max(r."createdAt") last_seen, count(distinct r."familyId") sign_ins,
         (array_agg(r."userAgent" order by r."createdAt" desc))[1] device
  from "RefreshToken" r join u on u.id = r."userId" group by r."userId"
),
c as (
  select o."userId", count(*) codes,
         string_agg(distinct right(o.phone, 10), ', ') numbers,
         (array_agg(o.failure order by o."createdAt" desc) filter (where o.failure is not null))[1] last_failure,
         bool_or(o.failure is null and o."consumedAt" is null) waiting
  from "OtpChallenge" o join u on u.id = o."userId" group by o."userId"
)
select u.name, u.email,
       to_char(u."createdAt" at time zone 'Asia/Kolkata', 'DD Mon HH24:MI') joined,
       s.sign_ins, to_char(s.last_seen at time zone 'Asia/Kolkata', 'DD Mon HH24:MI') last_seen,
       coalesce(c.codes, 0) codes, c.numbers,
       case
         when c."userId" is null and u."createdAt" < '2026-11-18' then 'no record (before tracking started)'
         when c."userId" is null then 'never asked for a code (left at the mobile step)'
         when c.last_failure like 'not sent%not on WhatsApp%' then 'number not on WhatsApp'
         when c.last_failure like 'not sent%' then 'WhatsApp could not send the code: ' || substr(c.last_failure, 11, 60)
         when c.last_failure like '%already has a GD Kites account%' then 'number already on another account'
         when c.last_failure like 'Incorrect code%' or c.last_failure like 'Too many%' then 'entered a wrong code'
         when c.last_failure like '%expired%' then 'code expired before it was entered'
         when c.last_failure is not null then c.last_failure
         else 'code sent, never entered'
       end reason,
       case when s.device ~* 'iphone|ipad' then 'iPhone (web)' when s.device ~* 'android' and s.device ~* 'mozilla' then 'Android (web)'
            when s.device ~* 'dart' then 'Android app' when s.device ~* 'macintosh|windows' then 'Computer (web)'
            else coalesce(left(s.device, 25), '?') end device
from u left join s on s."userId" = u.id left join c on c."userId" = u.id
order by u."createdAt" desc;
