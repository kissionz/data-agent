create schema if not exists semantic_sales;

create table semantic_sales.dwd_order_settlement (
  tenant_id text not null,
  workspace_id text not null,
  business_domain_id text not null,
  order_date date not null,
  completed_order_id text not null,
  net_revenue numeric(18, 2) not null,
  refund_order_count integer not null default 0,
  paid_order_count integer not null default 1,
  region_id text not null,
  sku_id text not null
);

create table semantic_sales.dim_sales_region (
  tenant_id text not null,
  region_id text not null,
  region_name text not null,
  primary key (tenant_id, region_id)
);

create table semantic_sales.dim_product_line_bridge (
  tenant_id text not null,
  sku_id text not null,
  product_line_name text not null
);

insert into semantic_sales.dim_sales_region (tenant_id, region_id, region_name) values
  ('tenant_demo', 'east', '华东'),
  ('tenant_demo', 'north', '华北'),
  ('tenant_other', 'east', '华东');

insert into semantic_sales.dwd_order_settlement (
  tenant_id, workspace_id, business_domain_id, order_date, completed_order_id,
  net_revenue, refund_order_count, paid_order_count, region_id, sku_id
) values
  ('tenant_demo', 'workspace_sales', 'sales', '2026-03-15', 'order_001', 1184000, 1, 100, 'east', 'sku_1'),
  ('tenant_demo', 'workspace_sales', 'sales', '2026-04-15', 'order_002', 1268000, 2, 120, 'east', 'sku_1'),
  ('tenant_demo', 'workspace_sales', 'sales', '2026-05-15', 'order_003', 1326000, 1, 130, 'north', 'sku_2'),
  ('tenant_demo', 'workspace_other', 'sales', '2026-05-15', 'order_004', 7000000, 0, 1, 'east', 'sku_1'),
  ('tenant_other', 'workspace_sales', 'sales', '2026-05-15', 'order_005', 9000000, 0, 1, 'east', 'sku_1'),
  ('tenant_demo', 'workspace_sales', 'finance', '2026-05-15', 'order_006', 8000000, 0, 1, 'east', 'sku_1');

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'chatbi_reader') then
    create role chatbi_reader login password 'chatbi_reader';
  end if;
end
$$;

alter role chatbi_reader set default_transaction_read_only = on;
revoke create on schema public from public;
grant connect on database chatbi_test to chatbi_reader;
grant usage on schema semantic_sales to chatbi_reader;
grant select on all tables in schema semantic_sales to chatbi_reader;
alter default privileges in schema semantic_sales grant select on tables to chatbi_reader;
