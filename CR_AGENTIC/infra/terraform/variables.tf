variable "aws_region" {
  type        = string
  default     = "us-east-1"
  description = "AWS region for all CR_AGENTIC resources."
}

variable "environment" {
  type        = string
  default     = "production"
  description = "Deployment environment name."
}

variable "name_prefix" {
  type        = string
  default     = "cr-agentic"
  description = "Prefix applied to all resource names."
}

variable "vpc_cidr" {
  type        = string
  default     = "10.40.0.0/16"
  description = "CIDR block for the CR_AGENTIC VPC (separate from the main Course Rep VPC)."
}

variable "az_count" {
  type        = number
  default     = 2
  description = "Number of availability zones to span."
}

# --- Database ---
variable "db_instance_class" {
  type        = string
  default     = "db.t4g.small"
  description = "RDS PostgreSQL instance class."
}

variable "db_allocated_storage" {
  type        = number
  default     = 20
  description = "RDS allocated storage in GB."
}

variable "db_name" {
  type        = string
  default     = "cr_agent"
  description = "Agent PostgreSQL database name."
}

variable "db_username" {
  type        = string
  default     = "agent"
  description = "Master username for the agent database."
}

# --- Redis ---
variable "redis_node_type" {
  type        = string
  default     = "cache.t4g.small"
  description = "ElastiCache Redis node type."
}

# --- ECS service sizing ---
variable "agent_api_cpu" {
  type    = number
  default = 512
}

variable "agent_api_memory" {
  type    = number
  default = 1024
}

variable "browser_worker_cpu" {
  type    = number
  default = 1024
}

variable "browser_worker_memory" {
  type    = number
  default = 2048
}

variable "ai_worker_cpu" {
  type    = number
  default = 512
}

variable "ai_worker_memory" {
  type    = number
  default = 1024
}

variable "discovery_worker_cpu" {
  type    = number
  default = 512
}

variable "discovery_worker_memory" {
  type    = number
  default = 1024
}

variable "agent_api_desired_count" {
  type    = number
  default = 2
}

variable "worker_desired_count" {
  type    = number
  default = 1
}

variable "image_tag" {
  type        = string
  default     = "latest"
  description = "Container image tag deployed to all services."
}

variable "course_rep_api_url" {
  type        = string
  description = "Base URL of the main Course Rep API, including the Nest global /api prefix (e.g. https://api.courserep.ng/api)."
}

variable "certificate_arn" {
  type        = string
  default     = ""
  description = "ACM certificate ARN for the ALB HTTPS listener. Leave empty to use HTTP only (dev)."
}
