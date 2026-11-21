-- CreateEnum
CREATE TYPE "Role" AS ENUM ('admin', 'office_head', 'employee');

-- CreateEnum
CREATE TYPE "EmployeeStatus" AS ENUM ('invited', 'active', 'inactive');

-- CreateEnum
CREATE TYPE "DayStatus" AS ENUM ('PRESENT', 'HALF_DAY_LATE', 'HALF_DAY_SHORT', 'MISSING_PUNCH', 'ABSENT', 'ON_LEAVE', 'OFF', 'HOLIDAY');

-- CreateEnum
CREATE TYPE "RequestStatus" AS ENUM ('pending', 'approved', 'rejected', 'cancelled');

-- CreateEnum
CREATE TYPE "LeaveType" AS ENUM ('CL', 'PL', 'UNPAID');

-- CreateEnum
CREATE TYPE "HalfDay" AS ENUM ('none', 'first', 'second');

-- CreateEnum
CREATE TYPE "OverrideKind" AS ENUM ('working', 'off');

-- CreateEnum
CREATE TYPE "PayrollStatus" AS ENUM ('open', 'locked');

-- CreateTable
CREATE TABLE "offices" (
    "id" UUID NOT NULL,
    "number" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "address" TEXT NOT NULL DEFAULT '',
    "start_time" VARCHAR(5) NOT NULL DEFAULT '09:00',
    "full_day_hours" DECIMAL(4,2) NOT NULL DEFAULT 9,
    "min_half_day_hours" DECIMAL(4,2) NOT NULL DEFAULT 4.5,
    "head_employee_id" UUID,
    "next_employee_seq" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "offices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "devices" (
    "id" UUID NOT NULL,
    "serial_number" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT '',
    "office_id" UUID NOT NULL,
    "last_seen_at" TIMESTAMPTZ(3),
    "last_attlog_stamp" TEXT,
    "silent_alert_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "devices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "unregistered_devices" (
    "serial_number" TEXT NOT NULL,
    "first_seen_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "request_count" INTEGER NOT NULL DEFAULT 1,
    "last_ip" TEXT,

    CONSTRAINT "unregistered_devices_pkey" PRIMARY KEY ("serial_number")
);

-- CreateTable
CREATE TABLE "employees" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT NOT NULL DEFAULT '',
    "designation" TEXT NOT NULL DEFAULT '',
    "office_id" UUID NOT NULL,
    "joining_date" DATE NOT NULL,
    "last_working_date" DATE,
    "terminal_user_id" TEXT,
    "status" "EmployeeStatus" NOT NULL DEFAULT 'invited',
    "best_streak" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "employees_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT '',
    "password_hash" TEXT,
    "role" "Role" NOT NULL,
    "employee_id" UUID,
    "invite_token_hash" TEXT,
    "invite_expires_at" TIMESTAMPTZ(3),
    "reset_token_hash" TEXT,
    "reset_expires_at" TIMESTAMPTZ(3),
    "last_login_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "user_id" UUID NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "salary_history" (
    "id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "monthly_amount" DECIMAL(12,2) NOT NULL,
    "effective_month" VARCHAR(7) NOT NULL,
    "set_by_id" UUID,
    "set_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "salary_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "raw_punches" (
    "id" BIGSERIAL NOT NULL,
    "device_id" UUID NOT NULL,
    "terminal_user_id" TEXT NOT NULL,
    "punch_time" TIMESTAMPTZ(3) NOT NULL,
    "received_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "raw_line" TEXT NOT NULL,

    CONSTRAINT "raw_punches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attendance_days" (
    "employee_id" UUID NOT NULL,
    "date" DATE NOT NULL,
    "check_in" TIMESTAMPTZ(3),
    "check_out" TIMESTAMPTZ(3),
    "hours" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "status" "DayStatus" NOT NULL,
    "paid_fraction" DECIMAL(2,1) NOT NULL,
    "is_manual" BOOLEAN NOT NULL DEFAULT false,
    "flags" JSONB NOT NULL DEFAULT '{}',
    "finalized" BOOLEAN NOT NULL DEFAULT false,
    "computed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attendance_days_pkey" PRIMARY KEY ("employee_id","date")
);

-- CreateTable
CREATE TABLE "correction_requests" (
    "id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "date" DATE NOT NULL,
    "claimed_in" VARCHAR(5),
    "claimed_out" VARCHAR(5),
    "reason" TEXT NOT NULL,
    "status" "RequestStatus" NOT NULL DEFAULT 'pending',
    "created_by_id" UUID,
    "decided_by_id" UUID,
    "decided_at" TIMESTAMPTZ(3),
    "comment" TEXT,
    "escalated_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "correction_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "leave_quotas" (
    "employee_id" UUID NOT NULL,
    "year" INTEGER NOT NULL,
    "cl_per_year" DECIMAL(4,1) NOT NULL,
    "pl_per_year" DECIMAL(4,1) NOT NULL,

    CONSTRAINT "leave_quotas_pkey" PRIMARY KEY ("employee_id","year")
);

-- CreateTable
CREATE TABLE "leave_ledger" (
    "id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "leave_type" "LeaveType" NOT NULL,
    "delta_days" DECIMAL(6,2) NOT NULL,
    "reason" TEXT NOT NULL,
    "ref" TEXT,
    "entry_date" DATE NOT NULL,
    "unique_key" TEXT,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "leave_ledger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "leave_requests" (
    "id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "type" "LeaveType" NOT NULL,
    "from_date" DATE NOT NULL,
    "to_date" DATE NOT NULL,
    "half_day" "HalfDay" NOT NULL DEFAULT 'none',
    "days" DECIMAL(4,1) NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "RequestStatus" NOT NULL DEFAULT 'pending',
    "decided_by_id" UUID,
    "decided_at" TIMESTAMPTZ(3),
    "comment" TEXT,
    "escalated_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "leave_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "holidays" (
    "id" UUID NOT NULL,
    "office_id" UUID NOT NULL,
    "date" DATE NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "holidays_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "calendar_overrides" (
    "id" UUID NOT NULL,
    "office_id" UUID NOT NULL,
    "date" DATE NOT NULL,
    "kind" "OverrideKind" NOT NULL,
    "name" TEXT NOT NULL DEFAULT '',

    CONSTRAINT "calendar_overrides_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payroll_runs" (
    "id" UUID NOT NULL,
    "office_id" UUID NOT NULL,
    "month" VARCHAR(7) NOT NULL,
    "status" "PayrollStatus" NOT NULL DEFAULT 'open',
    "reviewed_by_id" UUID,
    "reviewed_at" TIMESTAMPTZ(3),
    "locked_by_id" UUID,
    "locked_at" TIMESTAMPTZ(3),

    CONSTRAINT "payroll_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payroll_items" (
    "id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "employee_name" TEXT NOT NULL,
    "employee_code" TEXT NOT NULL,
    "designation" TEXT NOT NULL DEFAULT '',
    "monthly_salary" DECIMAL(12,2) NOT NULL,
    "days_in_month" INTEGER NOT NULL,
    "present" DECIMAL(4,1) NOT NULL,
    "half_days" DECIMAL(4,1) NOT NULL,
    "absent" DECIMAL(4,1) NOT NULL,
    "paid_leave" DECIMAL(4,1) NOT NULL,
    "unpaid_leave" DECIMAL(4,1) NOT NULL,
    "not_employed" DECIMAL(4,1) NOT NULL,
    "unpaid_days" DECIMAL(4,1) NOT NULL,
    "day_rate" DECIMAL(12,2) NOT NULL,
    "deduction" DECIMAL(12,2) NOT NULL,
    "net_salary" DECIMAL(12,2) NOT NULL,
    "trace" JSONB NOT NULL DEFAULT '[]',

    CONSTRAINT "payroll_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "badges" (
    "id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "ref" TEXT NOT NULL DEFAULT '',
    "earned_on" DATE NOT NULL,

    CONSTRAINT "badges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "read_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" BIGSERIAL NOT NULL,
    "actor_id" UUID,
    "actor_name" TEXT NOT NULL DEFAULT 'System',
    "office_id" UUID,
    "action" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "entity_id" TEXT,
    "detail" TEXT NOT NULL DEFAULT '',
    "old_value" JSONB,
    "new_value" JSONB,
    "sensitive" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settings" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,

    CONSTRAINT "settings_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "email_outbox" (
    "id" UUID NOT NULL,
    "to_email" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sent_at" TIMESTAMPTZ(3),

    CONSTRAINT "email_outbox_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "offices_number_key" ON "offices"("number");

-- CreateIndex
CREATE UNIQUE INDEX "offices_head_employee_id_key" ON "offices"("head_employee_id");

-- CreateIndex
CREATE UNIQUE INDEX "devices_serial_number_key" ON "devices"("serial_number");

-- CreateIndex
CREATE INDEX "devices_office_id_idx" ON "devices"("office_id");

-- CreateIndex
CREATE UNIQUE INDEX "employees_code_key" ON "employees"("code");

-- CreateIndex
CREATE UNIQUE INDEX "employees_terminal_user_id_key" ON "employees"("terminal_user_id");

-- CreateIndex
CREATE INDEX "employees_office_id_status_idx" ON "employees"("office_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "users_employee_id_key" ON "users"("employee_id");

-- CreateIndex
CREATE UNIQUE INDEX "users_invite_token_hash_key" ON "users"("invite_token_hash");

-- CreateIndex
CREATE UNIQUE INDEX "users_reset_token_hash_key" ON "users"("reset_token_hash");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_token_hash_key" ON "sessions"("token_hash");

-- CreateIndex
CREATE INDEX "sessions_user_id_idx" ON "sessions"("user_id");

-- CreateIndex
CREATE INDEX "sessions_expires_at_idx" ON "sessions"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "salary_history_employee_id_effective_month_key" ON "salary_history"("employee_id", "effective_month");

-- CreateIndex
CREATE INDEX "raw_punches_terminal_user_id_punch_time_idx" ON "raw_punches"("terminal_user_id", "punch_time");

-- CreateIndex
CREATE INDEX "raw_punches_received_at_idx" ON "raw_punches"("received_at");

-- CreateIndex
CREATE UNIQUE INDEX "raw_punches_device_id_terminal_user_id_punch_time_key" ON "raw_punches"("device_id", "terminal_user_id", "punch_time");

-- CreateIndex
CREATE INDEX "attendance_days_date_idx" ON "attendance_days"("date");

-- CreateIndex
CREATE INDEX "correction_requests_employee_id_date_idx" ON "correction_requests"("employee_id", "date");

-- CreateIndex
CREATE INDEX "correction_requests_status_idx" ON "correction_requests"("status");

-- CreateIndex
CREATE UNIQUE INDEX "leave_ledger_unique_key_key" ON "leave_ledger"("unique_key");

-- CreateIndex
CREATE INDEX "leave_ledger_employee_id_leave_type_idx" ON "leave_ledger"("employee_id", "leave_type");

-- CreateIndex
CREATE INDEX "leave_requests_employee_id_from_date_idx" ON "leave_requests"("employee_id", "from_date");

-- CreateIndex
CREATE INDEX "leave_requests_status_idx" ON "leave_requests"("status");

-- CreateIndex
CREATE UNIQUE INDEX "holidays_office_id_date_key" ON "holidays"("office_id", "date");

-- CreateIndex
CREATE UNIQUE INDEX "calendar_overrides_office_id_date_key" ON "calendar_overrides"("office_id", "date");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_runs_office_id_month_key" ON "payroll_runs"("office_id", "month");

-- CreateIndex
CREATE INDEX "payroll_items_employee_id_idx" ON "payroll_items"("employee_id");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_items_run_id_employee_id_key" ON "payroll_items"("run_id", "employee_id");

-- CreateIndex
CREATE UNIQUE INDEX "badges_employee_id_kind_ref_key" ON "badges"("employee_id", "kind", "ref");

-- CreateIndex
CREATE INDEX "notifications_user_id_created_at_idx" ON "notifications"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_log_office_id_created_at_idx" ON "audit_log"("office_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_log_created_at_idx" ON "audit_log"("created_at");

-- CreateIndex
CREATE INDEX "email_outbox_status_created_at_idx" ON "email_outbox"("status", "created_at");

-- AddForeignKey
ALTER TABLE "offices" ADD CONSTRAINT "offices_head_employee_id_fkey" FOREIGN KEY ("head_employee_id") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "devices" ADD CONSTRAINT "devices_office_id_fkey" FOREIGN KEY ("office_id") REFERENCES "offices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employees" ADD CONSTRAINT "employees_office_id_fkey" FOREIGN KEY ("office_id") REFERENCES "offices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "salary_history" ADD CONSTRAINT "salary_history_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "raw_punches" ADD CONSTRAINT "raw_punches_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_days" ADD CONSTRAINT "attendance_days_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "correction_requests" ADD CONSTRAINT "correction_requests_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leave_quotas" ADD CONSTRAINT "leave_quotas_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leave_ledger" ADD CONSTRAINT "leave_ledger_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "holidays" ADD CONSTRAINT "holidays_office_id_fkey" FOREIGN KEY ("office_id") REFERENCES "offices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calendar_overrides" ADD CONSTRAINT "calendar_overrides_office_id_fkey" FOREIGN KEY ("office_id") REFERENCES "offices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_office_id_fkey" FOREIGN KEY ("office_id") REFERENCES "offices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_items" ADD CONSTRAINT "payroll_items_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "payroll_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_items" ADD CONSTRAINT "payroll_items_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "badges" ADD CONSTRAINT "badges_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
