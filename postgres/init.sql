-- Database used by Camunda 8 as secondary storage (Tasklist / Operate / search API)
CREATE USER camunda WITH PASSWORD 'camunda';
CREATE DATABASE camunda OWNER camunda;
-- Database used by the Node.js HCP portal (business data + regulatory audit trail)
CREATE USER hcp WITH PASSWORD 'hcp';
CREATE DATABASE hcp OWNER hcp;
