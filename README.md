# CAMPus Complete

A role-aware college community MVP for students, teachers, admins and personal users.

## Account experiences
- **Personal:** normal 1-to-1 texting, discovery, profile and notifications. No college groups, timetable, attendance, events or academic tools.
- **Student:** college groups, chat, timetable, smart reminders, attendance, events, feed and discovery.
- **Teacher:** verified faculty tools for groups, attendance, timetable, events and Gmail group communication.
- **Admin:** teacher verification and college-level administration.

Teacher accounts cannot be approved from the admin console until all verification details are submitted. The admin can open **Review** to inspect the submitted institution, department, employee ID, qualification, subjects and proof link before selecting **Verify**.

## Included
- JWT authentication + bcrypt password hashing
- Socket.IO real-time chat, seen status and online presence
- Authenticated Socket.IO handlers are organized in `socket.js`; `server.js` attaches them to the same HTTP server that serves `/socket.io/socket.io.js`
- Course/year groups with unique join codes and member management
- Group student mass email through Gmail SMTP
- Timetable and automatic upcoming-class notifications
- Attendance sessions with expiring codes and student present/absent history
- Events/programs/workshops/seminars/competitions with detail modals
- Feed, likes, comments and share-link copying
- Profile editing
- Teacher verification workflow with required institution, department, employee ID, qualification, teaching subjects and proof-document link review

## Run
```bash
npm install
npm start
```
Open `http://localhost:3000`.

## Demo accounts
- Admin: `admin@campus.local` / `demo123`
- Verified teacher: `teacher@campus.local` / `demo123`
- Student: `demo@campus.local` / `demo123`
- Personal: `personal@campus.local` / `demo123`

## Gmail
Set `GMAIL_USER` and `GMAIL_APP_PASSWORD` in `.env` to enable group email and automatic timetable reminder emails. In the fixed-admin-sender setup, `GMAIL_USER` is the actual admin Gmail address used for SMTP authentication and delivery; the visible From name can identify the relevant teacher/admin. Reminder emails are sent once per upcoming class when the server detects that it starts within 10 minutes.

## Production note
Set a strong random `CAMPUS_SECRET` (at least 32 characters), set `NODE_ENV=production`, use HTTPS behind a reverse proxy, and configure a proper transactional email provider or Gmail app password before production use. Never commit `.env`, Gmail credentials, reset links or the `backups/` directory.

## Database backups
Create a consistent SQLite backup before deployments or on a scheduled job:
```bash
npm run backup
```
Backups are written to `backups/` with timestamped filenames. Store that directory outside the web server and copy it to protected, encrypted storage in production.

## Render deployment
This repository includes `render.yaml` for a Node web service with a persistent SQLite disk. Create a GitHub repository, push this project, then choose **New + → Blueprint** in Render and select the repository. Set `APP_URL` to the HTTPS URL Render assigns, then add the private Gmail and `ADMIN_SETUP_KEY` values in Render environment variables. Persistent disks may require a paid Render plan; without one, SQLite data can be lost on redeploy.

## Admin bootstrap
Public registration never accepts the `admin` role. For a fresh database only, set a private `ADMIN_SETUP_KEY` and use the server-side bootstrap process to create the first administrator; after an administrator exists, remove the key from the environment. Keep admin creation off the public signup form.
