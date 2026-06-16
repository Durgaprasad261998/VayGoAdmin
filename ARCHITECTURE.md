# VayGo Platform — Architecture Reference

This document gives a cross-project map of the VayGo ride-hailing platform so that
work on **VayGoAdmin** can be done with full context on how the backend and the
two mobile apps are built and how they talk to each other.

Repos (all under `D:\VAYGO`):

| Folder | Purpose | Stack |
|---|---|---|
| `VayGoAPI` | Backend REST API + SignalR | ASP.NET Core (namespace `VaygoTech`), EF Core, SQL Server |
| `VayGoAdmin` | **Admin web dashboard (this repo)** | Ionic 6 + Angular 12 |
| `VayGoRider` (folder `Raider`) | Driver / Captain mobile app | Ionic 8 + Angular 20, Capacitor (Android) |
| `VayGoUser` | Passenger mobile app | Ionic 8 + Angular 20, Capacitor (Android) |

## ⚠️ Domain terminology — read this first

The naming is **not** what it looks like at first glance:

- **"User"** = the **passenger/customer** who books rides → `VayGoUser` app, `UserController`, `User` model, `RideController`.
- **"Rider"** = the **driver/captain** who fulfills rides → `VayGoRider`/`Raider` app, `RiderController`, `Driver`/`DriverKYC`/`Vehicle` models.
- The `User` table has an `IsAdmin` bool — admin accounts are just users with `IsAdmin = true`, authenticated through the same OTP flow (`AuthController`).

---

## 1. VayGoAPI (Backend)

- ASP.NET Core Web API, root namespace `VaygoTech`, deployed to Azure App Service:
  `https://vaygotech-afhdbqfde5b0gkh0.centralindia-01.azurewebsites.net/api`
- EF Core + SQL Server (`AppDbContext`, connection string `DefaultConnection`). Raw schema reference at `VayGoAPI/VayGoAPI/SQL/schema.sql`.
- Auth: JWT Bearer (`Jwt:Key` / `Jwt:Issuer` / `Jwt:Audience` in config), with refresh tokens stored on `User`/`Driver`.
- Real-time: SignalR `NotificationHub` mapped at `/hubs/notifications` (JWT passed via `?access_token=` query string for hub connections).
- Logging: Serilog → console + `logs/log-.txt` (daily rolling).
- Mapping: AutoMapper, profile in `Helpers/Profiles/MappingProfile.cs`.
- Background work: `RideMatchingService` (hosted service) auto-matches ride requests to online drivers.
- Global error handling: `Middleware/ExceptionMiddleware`.
- CORS: `AllowAll` policy (open).
- Swagger/OpenAPI enabled with a Bearer auth scheme.
- Docker support via `Dockerfile`.

### Solution layout
```
VayGoAPI/VayGoAPI/VayGoAPI/
├── Controllers/   AdminController, AuthController, BaseController, PaymentController,
│                  RideController, RiderController, SubscriptionController, UserController
├── Services/      AdminService, AuthService, FileService, NotificationService,
│                  PaymentService, RiderService, RideService, SubscriptionService, UserService
├── Models/         Driver, DriverKYC, DriverSubscription, LoginRequest, OTPLog, Ride,
│                  RideAssignment, SubscriptionPayment, SubscriptionPlan, User, Vehicle
├── DTOs/           per-endpoint request/response shapes
├── Data/           AppDbContext, DbInitializer (seed data)
├── Hubs/           NotificationHub (SignalR)
├── Middleware/     ExceptionMiddleware
├── Helpers/        EncryptionHelper, LocationHelper, Profiles/MappingProfile
├── BackgroundServices/ RideMatchingService
└── SQL/schema.sql
```

### Core data model (`AppDbContext`)
- **User** — passenger account (`UserId`, `FullName`, `MobileNumber`, `Email`, `IsActive`, `IsAdmin`, refresh token).
- **Driver** — captain account (`DriverId`, `FullName`, `MobileNumber`, `IsApproved`, `RegistrationStatus` [Pending/Approved/Rejected], `RejectionReason`, `IsOnline`, `CurrentLat/Long`, `SubscriptionExpiryDate`, refresh token).
- **DriverKYC** — KYC docs per driver (Aadhaar masked/encrypted, driving licence + expiry, doc URLs, verified flags).
- **Vehicle** — per-driver vehicle (`VehicleType`, `VehicleNumber`, RC/insurance doc URLs + expiry).
- **SubscriptionPlan** — plan catalogue by `VehicleType`, `Amount`, `DurationInDays`.
- **DriverSubscription** — active/expired subscription per driver, linked to a plan.
- **SubscriptionPayment** — payment record (gateway order id, UPI txn id, `PaymentStatus`).
- **Ride** — ride lifecycle (`RideNumber`, pickup/drop lat-long + address, `EstimatedFare`/`FinalFare`, `RideStatus`, `Rating`, `UserId`, `DriverId`).
- **RideAssignment** — offer of a ride to a driver (`Status`: Pending/Accepted/Rejected), used by `RideMatchingService`.
- **OTPLog** — OTP codes for the mobile-number login flow.
- **RiderStatus** — driver online/offline + location tracking table.

### API surface (by controller)

| Controller | Route base | Endpoints |
|---|---|---|
| **AuthController** | `api/auth` | `POST send-otp`, `POST verify-otp`, `POST register`, `POST refresh-token` |
| **UserController** | `api/user` | `GET profile`, `PUT update-profile` |
| **RideController** | `api/ride` | `POST request`, `GET vehicle-types`, `GET history`, `POST rate/{rideId}`, `POST cancel/{rideId}` |
| **RiderController** | `api/rider` | `POST register`, `POST upload-documents`, `GET profile`, `POST go-online`, `POST go-offline`, `POST accept-ride`, `POST reject-ride`, `POST start-ride/{rideId}`, `POST end-ride/{rideId}`, `GET status`, `POST send-sms`, `POST upload-file` |
| **SubscriptionController** | `api/subscription` | `GET plans`, `POST create-order` |
| **PaymentController** | `api/payment` | `POST webhook` (payment gateway callback) |
| **AdminController** | `api/admin` | `GET drivers/pending`, `POST driver/approve`, `POST driver/reject`, `GET subscription/report`, `GET rides/report`, `GET users` |

**`AdminController` is the primary surface VayGoAdmin consumes.** Note its `[Authorize(Roles = "admin")]`
attribute is currently **commented out** — the API does not yet enforce admin-only
access on these routes server-side.

### Vehicle types (`Helpers/VehicleTypes.cs`)

9 vehicle types across 3 categories, used by `RideService` for matching, fare calculation,
and the `GET ride/vehicle-types` options endpoint:

| Category | Vehicle types | Fare multiplier |
|---|---|---|
| Bike | Bike EV, Scooter, Motor Bike | 0.70, 0.75, 0.85 |
| Auto | Auto | 1.00 |
| Car | Car Mini, Car Sedan, Car SUV, Car Prime, Car XL | 1.30, 1.50, 1.90, 1.70, 2.20 |

`VehicleTypes.Matches(driverVehicleType, requestedVehicleType)` does exact match first,
then falls back to category-level match — so legacy seeded `Vehicle.VehicleType` rows
that just say `"Bike"`/`"Car"`/`"Auto"` still match a specific sub-type request.

### Real-time ride booking workflow (SignalR)

End-to-end flow from passenger booking to driver accept/reject, via `NotificationHub`
(`/hubs/notifications`):

1. **VayGoUser** calls `GET ride/vehicle-types?pickupLat=&pickupLong=&dropLat=&dropLong=`
   to show all 9 vehicle types with estimated fare + count of nearby online drivers,
   then `POST ride/request` with the chosen `vehicleType`.
2. `RideService.RequestRideAsync` finds the nearest online driver (Haversine distance,
   `FareSettings:SearchRadiusKm`, default 10km) whose `Vehicle.VehicleType` matches via
   `VehicleTypes.Matches`, creates the `Ride` + a `RideAssignment` (`Status = "Pending"`),
   and sends `NewRideRequest` to `driver-{driverId}` with `AcceptWithinSeconds = 25`.
3. **VayGoRider** shows the offer with a 25s countdown ring. Driver calls
   `POST rider/accept-ride` (→ `RideAccepted` sent to `user-{userId}`) or
   `POST rider/reject-ride` (→ frees the ride for reassignment).
4. **`RideMatchingService`** (background hosted service, polls every 5s) handles both
   the reject case and the silent-timeout case: if the current `RideAssignment` is
   `Pending` for more than `RideService.AcceptWindowSeconds` (25s), it marks it
   `TimedOut` and offers the ride to the next nearest matching driver via a fresh
   `NewRideRequest`. Rides with no match after 5 minutes are auto-`Cancelled`.
5. Ride lifecycle continues via `POST rider/start-ride/{id}` → `RideStarted`,
   `POST rider/end-ride/{id}` → `RideCompleted` (both pushed to the passenger).
   Driver GPS pushed live via the hub method `UpdateLocation(lat,lng)` →
   `DriverLocationUpdate` sent to the passenger while a ride is `Accepted`/`Started`.

**Dev-mode auth fallback**: since `[Authorize]` is commented out on `NotificationHub`
and both apps currently run without real JWTs, `OnConnectedAsync` and `UpdateLocation`
fall back to `?userId=`/`?driverId=` query-string params on the hub URL (defaulting to
`1`, mirroring `BaseController.GetCurrentUserId()`) to join the `user-{id}`/`driver-{id}`
SignalR groups. Once real JWT auth is wired into the mobile apps, these query-string
params become redundant (the JWT claims take precedence) but are harmless to leave in.

**SMS notifications and the payment gateway are intentionally not wired into this flow
yet** — both are deferred follow-ups.

---

## 2. VayGoUser — Passenger app (`VayGoUser/VayGoUser`)

- Ionic 8 + Angular 20 (standalone components), Capacitor for Android.
- `src/app/`: `home/`, `login/`, `otp/`, `register/`, `registration/`.
- `src/environments/environment.ts` / `environment.prod.ts`:
  ```ts
  baseUrl: 'https://vaygotech-afhdbqfde5b0gkh0.centralindia-01.azurewebsites.net/api'
  userType: 'USER'
  googleMapsApiKey: '...'
  ```
- `src/app/services/api.ts` — `ApiService` wrapper (same `get/post/put/delete` pattern as
  VayGoRider), plus attaches `Authorization: Bearer <token>` from `localStorage.token` when present.
- `src/app/services/auth.service.ts` — wraps `ApiService` for `auth/send-otp` / `auth/verify-otp`
  (`userType: 'user'`), persists `token`/`userData` to `localStorage` on verify, plus `logout()`/`isLoggedIn()`.
- `src/app/services/maps.service.ts` — Google Distance Matrix / Places Autocomplete / Place Details /
  Directions / Geocoding wrappers, keyed off `environment.googleMapsApiKey`. Currently unused by
  `home/` (which uses Leaflet + OSM tiles + SignalR instead) — ported from the old prototype for
  parity but not wired into the live booking flow.
- `src/app/services/signalr.ts` — `SignalrService` connects to `/hubs/notifications?userId=<id>`
  (dev-mode id from `localStorage.userId`, default `1`) and exposes RxJS subjects:
  `rideAccepted$`, `rideCancelled$`, `rideStarted$`, `rideCompleted$`, `driverLocationUpdate$`.
- **Two parallel auth/onboarding paths** (both present, intentionally not merged):
  - **Real path** (`login` → `otp` → `register` → `home`): `login.page` calls
    `AuthService.sendOtp`, `otp.page` calls `AuthService.verifyOtp` against the live
    `AuthController`; a verified user with no `fullName` yet is sent to `register.page`,
    which `PUT user/update-profile`s the real backend before landing on `home`.
  - **Dummy path** (`registration` → `registration/otp` → `registration/step2`), reachable via
    "Create New Account" on the login screen: collects name/mobile/gender/referral locally
    (`RegistrationStateService`), gates on a **hardcoded OTP `123456`**, captures a profile
    photo via `@capacitor/camera`, then just redirects to `/login` — **none of this step hits
    the backend**. Ported verbatim from the old prototype (`VayGoUserOLD`) at the user's request;
    not real onboarding, just dormant/demo UI.
- `home/` page is the full booking flow: Leaflet map (pickup from geolocation, drop via map tap),
  `GET ride/vehicle-types` grid grouped by category (Bike/Auto/Car) with fare + nearby-driver count,
  `POST ride/request` to book, then live state machine
  (`selecting → searching → accepted → started → completed/cancelled`) driven by the SignalR
  subjects above, plus `POST ride/cancel/{id}` and `POST ride/rate/{id}`.

## 3. VayGoRider / "Raider" — Driver app (`VayGoRider/Raider`)

- Ionic 8 + Angular 20 (standalone components), Capacitor for Android, Leaflet for maps (`leaflet`, `@types/leaflet`).
- `src/environments/environment.ts`:
  ```ts
  baseUrl: 'https://vaygotech-afhdbqfde5b0gkh0.centralindia-01.azurewebsites.net/api'
  userType: 'RIDER'
  ```
- `src/app/services/api.ts` — thin `ApiService` wrapper over `HttpClient` (`get/post/put/delete`, JSON headers,
  base URL from environment, attaches `Authorization: Bearer <token>` from `localStorage.token` when present).
  **This is the pattern copied into VayGoAdmin.**
- `src/app/services/auth.service.ts` — wraps `ApiService` for `auth/send-otp` / `auth/verify-otp`
  (`userType: 'rider'`), persists `token`/`userData` to `localStorage`, plus `logout()`/`isLoggedIn()`.
- Routes (`app.routes.ts`, lazy-loaded standalone pages):
  - `login` → mobile number → `otp`. **Now wired to the real backend** (previously both pages
    were pure UI with a hardcoded OTP and no API calls at all): `login.page` calls
    `AuthService.sendOtp`, `otp.page` calls `AuthService.verifyOtp`; a returning driver with a
    `fullName` already set goes to `home`, a brand-new one goes to `registration`.
  - `registration` (driver onboarding, multi-step) — **unchanged, still uses its own dummy OTP**
    (`reg-otp.page`, hardcoded `123456`) separate from the top-level login OTP above:
    - `registration` (start) → `registration/otp` → `step2` → `step3` → `step4` → `payment`
    - has its own `registration-state.service.ts` to carry state across steps
    - `step3`/`step4` correspond to KYC + vehicle document uploads (`RiderController` `upload-documents` / `upload-file`), `payment` corresponds to `SubscriptionController.create-order`
  - `register` → redirects to `registration`
  - `home` → main driver screen (go online/offline, live ride-request flow, start/end ride)

This registration flow is what lands drivers in the `Driver.RegistrationStatus = "Pending"`
state that **VayGoAdmin's "pending drivers" review/approve/reject screen** operates on.

- `src/app/services/signalr.ts` — `SignalrService` connects to `/hubs/notifications?driverId=<id>`
  (dev-mode id from `localStorage.driverId`, default `1`), exposes `newRideRequest$` /
  `rideCancelled$`, and `updateLocation(lat,lng)` which invokes the hub's `UpdateLocation`
  method (called from the geolocation `watchPosition` callback while online).
- `home/` page: toggle online (`POST rider/go-online` with current lat/long, `POST rider/go-offline`)
  drives whether `NewRideRequest` offers are shown; each offer renders with a 25s countdown ring
  and Accept (`POST rider/accept-ride`) / Reject (`POST rider/reject-ride`) actions; an accepted
  ride shows Start Ride (`POST rider/start-ride/{id}`) then End Ride (`POST rider/end-ride/{id}`).

## 4. VayGoAdmin — Admin web dashboard (this repo)

- **Scaffolded with Ionic 6 + Angular 12** (NgModule-based, not standalone) — see
  "Known issues" below for why this differs from the other two frontends.
- `src/environments/environment.ts` / `environment.prod.ts`:
  ```ts
  baseUrl: 'https://vaygotech-afhdbqfde5b0gkh0.centralindia-01.azurewebsites.net/api'
  userType: 'ADMIN'
  ```
- `src/app/services/api.ts` — same `ApiService` wrapper as VayGoRider (`HttpClient` + `environment.baseUrl`).
- `HttpClientModule` registered in `app.module.ts`; `IonicModule.forRoot()` already wired.
- Intended scope (maps directly to `AdminController`):
  - Pending driver review queue (`GET /admin/drivers/pending`) with approve/reject actions
    (`POST /admin/driver/approve`, `POST /admin/driver/reject` with a reason)
  - Subscription revenue report by vehicle type (`GET /admin/subscription/report`)
  - Rides summary/completion report (`GET /admin/rides/report`)
  - User listing (`GET /admin/users`)
  - Admin login should reuse the OTP flow in `AuthController` (`send-otp`/`verify-otp`),
    gated on `User.IsAdmin = true`.

---

## Cross-cutting notes / known issues

1. **Toolchain version mismatch (tech debt).** The dev machine has Node v14.17.4 with
   a global Angular CLI v12.1.4. VayGoUser/VayGoRider were built with **Angular 20 +
   Ionic 8** (require Node ≥18.19). VayGoAdmin was created with **Angular 12 + Ionic 6**
   to match what the current toolchain can build/run. To bring VayGoAdmin in line with
   the mobile apps (standalone components, Ionic 8), upgrade Node to 20.11+/22 LTS and
   re-scaffold or incrementally upgrade (`ng update`) to Angular 20 + `@ionic/angular@8`.
2. **Shared API conventions**: every frontend talks to the same base URL
   (`.../azurewebsites.net/api`) via a small `ApiService` (`get/post/put/delete` over
   `HttpClient`, `Content-Type: application/json`, JWT to be added via `Authorization`
   header once login is wired up). Replicate this service in any new frontend rather
   than reinventing it.
3. **Auth is OTP-based**, not username/password: `send-otp` → `verify-otp` returns JWT
   access + refresh tokens. `LoginRequest` (email/password) exists as a model but the
   controllers use the OTP flow. As of the latest pass, **both VayGoUser's and VayGoRider's
   top-level `login`/`otp` pages actually call this real flow** via each app's
   `services/auth.service.ts` — previously they were disconnected UI shells (VayGoRider's
   OTP step in particular just checked against a hardcoded `123456`). The driver app's
   deeper `registration/` onboarding flow (KYC/vehicle docs/payment) still uses its own
   separate dummy OTP and is not yet wired to `RiderController`/`SubscriptionController`.
4. **CORS is wide open (`AllowAll`)** and `AdminController`'s role check is currently
   disabled — both should be tightened before production use of the admin dashboard.
5. **SMS and payment-gateway integration are deferred** — the ride-booking workflow
   (request → match → accept/reject → start → end) is fully wired end-to-end via
   SignalR, but no SMS notifications or payment capture happen yet.
6. **Two retired prototype repos exist** alongside the live apps, kept for reference only:
   - `VayGoUserOLD` — an earlier, more complete passenger-app prototype. Its
     `User_registerPage` branch was the source for VayGoUser's `auth.service.ts`,
     `register`/`registration` pages, and `maps.service.ts` (ported in this pass).
     Its `environment.prod.ts` has a **real Google Maps API key committed in plaintext**
     in git history — rotate/restrict it if this repo is ever pushed anywhere shared.
   - `VayGoRaiderOLD` — a much earlier, abandoned driver-app prototype (email/password
     login, no backend wiring at all, no OTP/registration/services). Fully superseded
     by the current VayGoRider app; nothing in it is worth porting.
7. **Ionic dark-mode CSS pitfall**: leaving `@import '@ionic/angular/css/palettes/dark.system.css';`
   uncommented in `global.scss` makes `ion-item`/`ion-input` render with a dark/near-black
   background on devices with system dark mode on, clashing with the apps' custom white
   `.card` panels (visible as "black fields" on login/OTP/registration forms). VayGoRider's
   `global.scss` already had this commented out; VayGoUser's did not and was fixed to match.
   Keep this commented out in any new frontend built off this pattern.
