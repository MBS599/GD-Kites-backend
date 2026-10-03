import { IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

export class GoogleSignInDto {
  /** Google ID token from the mobile Google Sign-In SDK. */
  @IsString()
  @MinLength(10)
  idToken: string;
}

export class RefreshDto {
  @IsString()
  @MinLength(20)
  refreshToken: string;
}

export class OtpRequestDto {
  /** Indian mobile number, any common format (98220 11122, +91…). */
  @IsString()
  @MaxLength(20)
  phone: string;
}

export class PhoneLinkDto extends OtpRequestDto {
  @Matches(/^\d{6}$/, { message: 'Enter the 6-digit code.' })
  code: string;
}

export class OtpVerifyDto extends OtpRequestDto {
  @Matches(/^\d{6}$/, { message: 'Enter the 6-digit code.' })
  code: string;

  /** Required only when this number has no account yet. */
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  name?: string;
}

export class AuthUserDto {
  id: string;
  email: string;
  name: string;
  phone: string | null;
  businessName: string | null;
  photoUrl: string | null;
  /** customer | driver | admin */
  role: string;
  driverId: string | null;
}

export class AuthSessionDto {
  accessToken: string;
  /** Kept for older clients; same as accessToken. */
  token: string;
  refreshToken: string;
  /** Access token lifetime in seconds. */
  expiresIn: number;
  user: AuthUserDto;
}
