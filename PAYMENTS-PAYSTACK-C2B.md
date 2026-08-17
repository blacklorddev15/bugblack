# BLACKLORD TECH INC — Paystack and M-Pesa Payments

The platform supports three payment choices: **Paystack hosted checkout**, **M-Pesa C2B Till**, and **M-Pesa STK Push through Safaricom Daraja**. Legacy Courtney, Blacklord STK proxy, Paybill-display, and manual bank-transfer flows are not used by the website wallet.

## Paystack

Set `PAYSTACK_SECRET` in Vercel or save it through **Admin → Paystack & M-Pesa Payments**. Configure the Paystack webhook URL as:

```text
https://YOUR_DOMAIN/api/paystack/webhook
```

Paystack sends a signed `charge.success` event. The webhook validates `x-paystack-signature`, matches the reference to a pending Paystack deposit created by the website, and credits the wallet exactly once.

## M-Pesa C2B Till

Configure the authorized C2B provider or Safaricom Daraja application with:

```text
https://YOUR_DOMAIN/api/c2b/validation
https://YOUR_DOMAIN/api/c2b/confirmation
```

Set the following values in Vercel or through the Admin Panel:

```env
MPESA_C2B_TILL_NUMBER=YOUR_TILL_NUMBER
MPESA_KES_PER_SD=5
MPESA_C2B_INSTRUCTIONS=Open M-Pesa, choose Lipa na M-Pesa, Buy Goods and Services, enter the Till number, pay, and keep the transaction code.
```

The C2B confirmation endpoint validates the Till where supplied, reads `TransID`, `TransAmount`, and `MSISDN`, converts KES to SD, creates a `c2b` deposit, and uses the existing atomic wallet-credit function. Duplicate transaction IDs are ignored safely.

## M-Pesa STK Push

STK Push uses the official Safaricom Daraja OAuth and Lipa na M-Pesa Online APIs. The user enters a Kenyan phone number and amount; the website requests a payment prompt, the user enters the M-Pesa PIN, and Daraja calls the callback endpoint:

```text
https://YOUR_DOMAIN/api/mpesa/stk/callback
```

The website routes are:

```text
GET  /api/mpesa/stk/config
POST /api/mpesa/stk/initiate
POST /api/mpesa/stk/status
POST /api/mpesa/stk/callback
```

Required server-side variables are:

```env
MPESA_STK_ENV=sandbox
MPESA_CONSUMER_KEY=YOUR_DARAJA_CONSUMER_KEY
MPESA_CONSUMER_SECRET=YOUR_DARAJA_CONSUMER_SECRET
MPESA_STK_SHORTCODE=YOUR_SHORTCODE_OR_TILL
MPESA_STK_PASSKEY=YOUR_STK_PASSKEY
MPESA_STK_TRANSACTION_TYPE=CustomerBuyGoodsOnline
MPESA_STK_PARTY_B=YOUR_TILL_OR_PAYBILL
MPESA_STK_ACCOUNT_REFERENCE=BLACKLORD
MPESA_STK_CALLBACK_URL=https://YOUR_DOMAIN/api/mpesa/stk/callback
```

Use `CustomerBuyGoodsOnline` for a Till and `CustomerPayBillOnline` for a PayBill shortcode. The handler obtains an OAuth access token, generates the timestamped Daraja password, sends `processrequest`, stores the returned `CheckoutRequestID`, and never credits a wallet from the browser alone. Only a successful callback with `ResultCode = 0` credits the corresponding pending deposit.

For production, change `MPESA_STK_ENV` to `production` and use the production Daraja base URL. Register the callback URL in the Daraja application. Test the full flow with a sandbox app before enabling production payments.

## Customer flows

For Paystack, the customer opens the hosted checkout and the wallet is credited after the signed webhook or verification confirms success. For C2B, the customer pays the Till and enters the M-Pesa transaction code to check whether the provider confirmation has arrived. For STK Push, the customer receives a phone prompt, enters the PIN, and waits for the callback-driven confirmation.

Do not commit Paystack secrets, Daraja consumer credentials, passkeys, or private provider credentials to GitHub. Safaricom Daraja provides the official portal and API access for integrating M-Pesa services into web and mobile applications [1].

## References

[1]: https://developer.safaricom.co.ke/ "Safaricom Daraja Developer Portal"
