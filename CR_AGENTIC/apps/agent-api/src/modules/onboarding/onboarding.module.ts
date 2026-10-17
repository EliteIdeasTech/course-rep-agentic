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

@Module({
  imports: [AuthModule, NotificationsModule],
  controllers: [OnboardingController],
  providers: [
    OnboardingService,
    PortalService,
    LoginService,
    DeepDiscoveryService,
    SyncService,
    BackgroundImportService,
    sessionStorageProvider,
  ],
  exports: [OnboardingService],
})
export class OnboardingModule {}
