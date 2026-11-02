import { Module } from '@nestjs/common';
import { OnboardingController } from './onboarding.controller';
import { OnboardingService } from './onboarding.service';
import { PortalService } from './portal.service';
import { LoginService } from './login.service';
import { DeepDiscoveryService } from './deep-discovery.service';
import { SyncService } from './sync.service';
import { sessionStorageProvider } from './session-storage.provider';
import { AuthModule } from '../auth/auth.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { BackgroundImportService } from './background-import.service';
import { PortalFunnelAdminController } from './portal-funnel-admin.controller';
import { FunnelErrorInterceptor } from './funnel-error.interceptor';

@Module({
  imports: [AuthModule, NotificationsModule],
  controllers: [OnboardingController, PortalFunnelAdminController],
  providers: [
    OnboardingService,
    PortalService,
    LoginService,
    DeepDiscoveryService,
    SyncService,
    BackgroundImportService,
    FunnelErrorInterceptor,
    sessionStorageProvider,
  ],
  exports: [OnboardingService],
})
export class OnboardingModule {}
